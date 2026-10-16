const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createMock } = require('../../tests/fixtures/claude-mock-api.cjs');
const { packagedExecutable } = require('./platform/executable.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-packaged-harness-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const app = await _electron.launch({
    executablePath: process.env.STUDIO_PACKAGED || packagedExecutable(),
    args: [],
    env,
  });
  try {
    await require('./setup/helpers.cjs').overview(await app.firstWindow());
    const run = await app.evaluate(async ({ app }, port) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(`${app.getAppPath()}/package.json`);
      const path = require('node:path');

      const appDir = app.getAppPath();
      const { Agent } = require(path.join(appDir, 'dist/harness/coordinator.cjs'));
      const { ClaudeAdapter } = require(path.join(appDir, 'dist/ai/adapters/claude.cjs'));
      const { Store, DEFAULTS } = require(path.join(appDir, 'dist/persistence/store.cjs'));
      const { ClaudeProcess } = require(path.join(appDir, 'dist/transport/claude/process.cjs'));
      const { bundledClaude } = require(path.join(appDir, 'dist/services/agents/bundled.cjs'));

      const adapter = new ClaudeAdapter(
        (file, args, cwd, env) =>
          new ClaudeProcess(file, args, cwd, {
            ...env,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          })
      );
      const store = new Store(':memory:');
      const project = store.createProject('package-test');
      const meeting = store.createMeeting(project.id, 'package-test');
      const settings = structuredClone(DEFAULTS);
      settings.llm = {
        ...settings.llm,
        backend: 'claude',
        claudeKey: 'local-test',
        claudeModel: 'test',
        claudeAuth: 'api',
        claudePath: await bundledClaude(),
      };
      store.saveSettings(settings);
      const agent = new Agent(
        store,
        path.join(appDir, 'skills'),
        () => {},
        path.join(app.getPath('userData'), 'packaged-runtime'),
        [adapter]
      );
      try {
        return await agent.run({ meetingId: meeting.id, instruction: '整理紀錄' });
      } finally {
        await agent.close();
        store.close();
      }
    }, mock.server.address().port);
    assert.equal(run.status, 'proposed', JSON.stringify(run.events));
    assert.match(run.notes, /Claude 本機測試/);
    assert(run.events.some((e) => e.type === 'tool' && e.name === 'studio_read_notes'));
    console.log(
      'Packaged Electron + bundled Claude CLI -p + HTTP MCP gateway passed against local mock API.'
    );
  } finally {
    await app.close();
    mock.server.closeAllConnections();
    await new Promise((r) => mock.server.close(r));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
