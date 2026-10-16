const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { DEFAULTS } = require('../../dist/persistence/store.cjs');
const { CodexAdapter } = require('../../dist/ai/adapters/codex.cjs');
const { ClaudeAdapter } = require('../../dist/ai/adapters/claude.cjs');

test('native CLI transports send every image in native content blocks and disable session persistence for temporary runs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-native-images-'));
  const prior = process.env.STUDIO_FIXTURE_TRACE;
  try {
    for (const backend of ['codex', 'claude']) {
      const trace = path.join(directory, `${backend}.jsonl`);
      process.env.STUDIO_FIXTURE_TRACE = trace;
      const settings = structuredClone(DEFAULTS);
      Object.assign(settings.llm, {
        backend,
        codexAuth: 'cli',
        claudeAuth: 'cli',
        codexPath: path.resolve('tests/fixtures/agent-cli.cjs'),
        claudePath: path.resolve('tests/fixtures/agent-cli.cjs'),
      });
      const controller = new AbortController();
      const images = [1, 2].map((id) => ({
        id: String(id),
        name: `${id}.png`,
        mime: 'image/png',
        dataUrl: `data:image/png;base64,${Buffer.from(`image-${id}`).toString('base64')}`,
      }));
      const ctx = {
        settings,
        images,
        ephemeral: true,
        runtimeDir: directory,
        project: { id: 'project', roots: [] },
        meeting: {},
        controller,
        signal: controller.signal,
        maxSteps: 3,
        prompt: 'look',
        instructions: 'read',
        tools: {
          specs: () => [],

          call: async () => null,
        },

        bindSession: () => {},

        emit: () => {},
      };
      const adapter = backend === 'codex' ? new CodexAdapter() : new ClaudeAdapter();
      await adapter.execute(ctx);
      const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
      if (backend === 'codex') {
        assert.equal(events.find((e) => e.method === 'thread/start').params.ephemeral, true);
        const content = events.find((e) => e.method === 'turn/start').params.input;
        assert.equal(content.filter((c) => c.type === 'image').length, 2);
        assert.deepEqual(
          content.filter((c) => c.type === 'image').map((c) => c.url),
          images.map((i) => i.dataUrl)
        );
      } else {
        assert.ok(
          events.find((e) => e.args?.includes('-p')).args.includes('--no-session-persistence')
        );
        const content = events.find((e) => e.type === 'user').message.content;
        assert.equal(content.filter((c) => c.type === 'image').length, 2);
        assert.deepEqual(
          content
            .filter((c) => c.type === 'image')
            .map((c) => Buffer.from(c.source.data, 'base64').toString()),
          ['image-1', 'image-2']
        );
      }
    }
  } finally {
    if (prior === undefined) delete process.env.STUDIO_FIXTURE_TRACE;
    else process.env.STUDIO_FIXTURE_TRACE = prior;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
