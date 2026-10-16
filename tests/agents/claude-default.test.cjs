const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Agent } = require('../../dist/harness/coordinator.cjs');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');
const { executableCandidates } = require('../../dist/services/agents/executable.cjs');
const { createMock } = require('../fixtures/claude-mock-api.cjs');

test('real Claude -p CLI mode inherits environment credentials and the user default model with no Studio key', {
  timeout: 30000,
}, async (t) => {
  const [file] = await executableCandidates('claude');
  if (!file) {
    t.skip('Claude CLI is not installed');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-claude-default-'));
  const home = path.join(root, 'cli-home');
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({ model: 'default-from-cli-settings' })
  );
  const mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const changes = {
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: 'local-fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.server.address().port}`,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  };
  const before = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));

  const assign = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  assign(changes);
  const store = new Store(':memory:');
  const project = store.createProject('cli defaults'),
    meeting = store.createMeeting(project.id, 'meeting');
  const settings = structuredClone(DEFAULTS);
  Object.assign(settings.llm, {
    backend: 'claude',
    claudeAuth: 'cli',
    claudePath: file,
    claudeKey: '',
    claudeModel: '',
  });
  store.saveSettings(settings);
  const agent = new Agent(store, path.resolve('skills'), () => {}, path.join(root, 'runtime'));
  try {
    const run = await agent.run({ meetingId: meeting.id, instruction: '整理紀錄' });
    assert.equal(run.status, 'proposed', JSON.stringify(run.events));
    assert(mock.bodies.length > 0);
    assert(mock.bodies.every((body) => body.model === 'default-from-cli-settings'));
    assert.equal(store.settings().llm.claudeKey, '');
    assert.equal(store.get('meetings', meeting.id).agentSessions.claude.home, home);
  } finally {
    await agent.close();
    store.close();
    assign(before);
    mock.server.closeAllConnections();
    await new Promise((r) => mock.server.close(r));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
