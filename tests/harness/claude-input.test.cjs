const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Agent } = require('../../dist/harness/coordinator.cjs');
const { ClaudeAdapter } = require('../../dist/ai/adapters/claude.cjs');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');
const { claudeCli } = require('../fixtures/claude-cli.cjs');

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

for (const heldRequest of [1, 2])
  test(`real Claude streaming input retains a follow-up during inference ${heldRequest}`, {
    timeout: 30000,
  }, async () => {
    const { createMock } = require('../fixtures/claude-mock-api.cjs');

    const entered = deferred();
    const release = deferred();
    let meetingRequests = 0;
    const mock = createMock({
      beforeMessage: async (data) => {
        if (
          data.tools?.some((tool) => tool.name === 'mcp__meeting__meeting_tool') &&
          ++meetingRequests === heldRequest
        ) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
    const adapter = new ClaudeAdapter((file, args, cwd, env) => {
      const { ClaudeProcess } = require('../../dist/transport/claude/process.cjs');

      return new ClaudeProcess(file, args, cwd, {
        ...env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.server.address().port}`,
      });
    });
    const store = new Store(':memory:');
    const p = store.createProject('Claude steering');
    const m = store.createMeeting(p.id, 'meeting');
    const settings = structuredClone(DEFAULTS);
    settings.llm.backend = 'claude';
    settings.llm.claudeKey = 'test';
    settings.llm.claudeModel = 'test';
    settings.llm.claudePath = claudeCli();
    store.saveSettings(settings);
    const events = [];
    const image = {
      id: require('node:crypto').randomUUID(),
      name: 'fixture.png',
      mime: 'image/png',
      width: 128,
      height: 128,
      dataUrl:
        'data:image/png;base64,' +
        fs.readFileSync(path.resolve('config/branding/native/icon.png')).toString('base64'),
    };
    const agent = new Agent(
      store,
      path.join(__dirname, '../../skills'),
      (e) => events.push(e),
      fs.mkdtempSync(path.join(os.tmpdir(), 'studio-claude-steer-')),
      [adapter],
      { load: async (request) => (request.images || []).map(() => image) }
    );
    try {
      const run = agent.run({ meetingId: m.id, instruction: 'first instruction', images: [image] });
      await Promise.race([
        entered.promise,
        run.then((completed) =>
          assert.fail(
            `Claude finished before reaching the mock API: ${JSON.stringify(completed.events)}`
          )
        ),
      ]);
      const result = await agent.submit(
        { meetingId: m.id, instruction: 'STEER_FOLLOWUP_INCLUDE_OWNER', images: [image] },
        'steer',
        agent.inputState(m.id).activeRunId
      );
      assert.equal(result.disposition, 'steered');
      release.resolve();
      const completed = await run;
      assert.equal(completed.status, 'proposed', JSON.stringify(completed.events));
      assert(
        mock.bodies.some((body) =>
          JSON.stringify(body.messages).includes('STEER_FOLLOWUP_INCLUDE_OWNER')
        )
      );
      assert.equal(events.filter((e) => e.type === 'proposal').length, 1);
      assert(
        mock.bodies.some(
          (body) =>
            body.messages
              .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
              .filter((part) => part.type === 'image').length >= 2
        ),
        'initial and steering images reach the real Claude provider request'
      );
    } finally {
      release.resolve();
      await agent.close();
      store.close();
      mock.server.closeAllConnections();
      await new Promise((r) => mock.server.close(r));
    }
  });
