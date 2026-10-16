const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const workspace = require('../../dist/services/workspace/files.cjs');
const {
  resolveReference,
  validateReferences,
} = require('../../dist/services/workspace/references/resolve.cjs');
const { Agent } = require('../../dist/harness/coordinator.cjs');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');

after(() => workspace.closeWorkspace());

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-mentions-'));
  const roots = [{ id: 'root', name: '資料', path: directory, mode: 'readonly' }];
  try {
    await run(directory, roots);
  } finally {
    await workspace.closeWorkspace();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('mention batches include folders/root and deep files, remain bounded and normalize path separators', () =>
  fixture(async (dir, roots) => {
    await fs.mkdir(path.join(dir, 'nested', '更深'), { recursive: true });
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, '.env'), 'secret');
    await fs.writeFile(path.join(dir, 'node_modules', 'ignore.md'), 'ignore');
    await fs.writeFile(path.join(dir, 'nested', '更深', '規 格.md'), '正文');
    await Promise.all(
      Array.from({ length: 650 }, (_, n) => fs.writeFile(path.join(dir, `ref-${n}.txt`), '內容'))
    );
    let cursor,
      all = [],
      page;
    do {
      page = await workspace.mentionFiles(roots, '', { cursor });
      assert.ok(page.files.length <= 20);
      all.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(all.length, 654);
    assert.equal(all.filter((r) => r.kind === 'directory').length, 3);
    assert.ok(all.some((r) => r.kind === 'directory' && r.relative === ''));
    assert.ok(!all.some((r) => /node_modules|\.env/.test(r.relative)));
    const deep = await workspace.mentionFiles(roots, 'nested/更深/規 格.md');
    assert.equal(deep.files.length, 1);
    assert.equal(deep.files[0].kind, 'file');
    const first = await workspace.mentionFiles(roots, 'ref-');
    await assert.rejects(
      workspace.mentionFiles(roots, 'nested', { cursor: first.nextCursor }),
      /查詢/
    );
    const second = await workspace.mentionFiles(roots, 'ref-', { cursor: first.nextCursor });
    workspace.releaseCursor(second.nextCursor);
  }));
test('direct reference lookup does not depend on listing; scoped list/search do not leave the chosen folder', () =>
  fixture(async (dir, roots) => {
    await fs.mkdir(path.join(dir, 'scope', 'inner'), { recursive: true });
    await fs.writeFile(path.join(dir, 'scope', 'inner', 'target.md'), 'special keyword');
    await fs.writeFile(path.join(dir, 'outside.txt'), 'special keyword');
    await fs.writeFile(path.join(dir, 'unsupported.pdf'), 'PDF');
    const ref = await resolveReference(roots, 'root', 'scope/inner/target.md');
    assert.equal(ref.relative, 'scope/inner/target.md');
    assert.equal((await resolveReference(roots, 'root', 'scope')).kind, 'directory');
    assert.equal((await resolveReference(roots, 'root', '')).kind, 'directory');
    assert.equal(
      (await validateReferences(roots, [{ ...ref, rootName: 'forged' }]))[0].rootName,
      '資料'
    );
    await assert.rejects(resolveReference(roots, 'root', '../outside.txt'), /超出/);
    await assert.rejects(resolveReference(roots, 'bad', ''), /授權/);
    await assert.rejects(resolveReference(roots, 'root', 'unsupported.pdf'), /轉成文字/);
    await assert.rejects(validateReferences(roots, Array(21).fill(ref)), /20/);
    await assert.rejects(
      validateReferences(roots, [{ ...ref, relative: '../outside.txt' }]),
      /超出/
    );
    const listing = await workspace.listFiles(roots, '', { rootId: 'root', directory: 'scope' });
    assert.deepEqual(
      listing.files.map((r) => r.relative.replaceAll('\\', '/')),
      ['scope/inner/target.md']
    );
    const search = await workspace.searchFiles(roots, 'special', {
      rootId: 'root',
      directory: 'scope',
    });
    assert.equal(search.matches.length, 1);
    assert.match(search.matches[0].relative, /target.md/);
    await assert.rejects(workspace.listFiles(roots, '', { directory: 'scope' }), /rootId/);
    await assert.rejects(workspace.listFiles(roots, '', { rootId: 'bad' }), /rootId/);
    const escape = await workspace.listFiles(roots, '', { rootId: 'root', directory: '..' });
    assert.equal(escape.files.length, 0);
    assert.match(escape.errors.join(), /超出/);
  }));
test('per-message references are validated, journaled and passed to native steering without leaking to later turns', () =>
  fixture(async (dir, roots) => {
    await fs.writeFile(path.join(dir, 'reference.md'), 'source');
    const store = new Store(':memory:');
    const project = store.createProject('mentions');
    store.updateProject(project.id, { roots });
    const meeting = store.createMeeting(project.id, 'mentions');
    const settings = structuredClone(DEFAULTS);
    settings.llm.apiKey = 'fixture';
    settings.llm.model = 'fixture';
    store.saveSettings(settings);
    let finish, context, steered;
    const gate = new Promise((r) => {
      finish = r;
    });
    const prompts = [];
    const agent = new Agent(store, path.resolve('skills'), () => {}, undefined, [
      {
        id: 'openai',

        async execute(ctx) {
          context = ctx;
          prompts.push(JSON.parse(ctx.prompt));
          ctx.bindSteer(async (text) => {
            steered = text;
            return true;
          });
          if (prompts.length === 1) await gate;
          return '# result';
        },
      },
    ]);
    try {
      const file = { kind: 'file', rootId: 'root', rootName: 'forged', relative: 'reference.md' };
      const first = agent.run({ meetingId: meeting.id, instruction: 'first', references: [file] });
      for (let i = 0; i < 200 && !context; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(context);
      assert.equal(prompts[0].references[0].rootName, '資料');
      assert.equal(prompts[0].availableFolders[0].rootId, 'root');
      const result = await agent.submit(
        {
          meetingId: meeting.id,
          instruction: 'steer',
          references: [{ kind: 'search', query: '查不到的關鍵字' }],
        },
        'steer',
        agent.inputState(meeting.id).activeRunId
      );
      assert.equal(result.disposition, 'steered');
      assert.match(steered, /查不到的關鍵字/);
      const queued = await agent.submit({
        meetingId: meeting.id,
        instruction: 'second',
        references: [],
      });
      assert.deepEqual(store.list('runs').find((r) => r.id === queued.id).input.references, []);
      await assert.rejects(
        agent.submit({
          meetingId: meeting.id,
          instruction: 'bad',
          references: [{ ...file, relative: 'missing.md' }],
        }),
        /ENOENT/
      );
      finish();
      const run = await first;
      assert.equal(
        run.events.find((e) => e.type === 'request').args.references[0].relative,
        'reference.md'
      );
      for (let i = 0; i < 200 && agent.isRunningMeeting(meeting.id); i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(prompts[1].references, []);
    } finally {
      finish();
      await agent.close();
      store.close();
    }
  }));
