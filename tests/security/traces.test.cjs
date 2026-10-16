const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../../dist/harness/coordinator.cjs');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');

test('credential-bearing errors and tool events are masked before UI emission and JSONL append', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-private-trace-'));
  const store = new Store(path.join(directory, 'studio.sqlite'));
  const settings = structuredClone(DEFAULTS);
  settings.llm.apiKey = 'fixture-trace-model-secret';
  settings.llm.model = 'fixture';
  settings.mcp = [];
  store.saveSettings(settings);
  const project = store.createProject('trace');
  const meeting = store.createMeeting(project.id, 'trace');
  const events = [];
  const adapter = {
    id: 'openai',

    async execute(ctx) {
      ctx.emit({
        type: 'tool',
        name: 'fixture',
        args: { token: 'fixture-inline-secret', offset: 20 },
      });
      ctx.emit({
        type: 'tool-result',
        name: 'fixture',
        result: { text: settings.llm.apiKey, count: 4 },
      });
      throw new Error(`Provider returned ${settings.llm.apiKey}`);
    },
  };
  const agent = new Agent(store, path.resolve('skills'), (event) => events.push(event), undefined, [
    adapter,
  ]);
  try {
    const run = await agent.run({ meetingId: meeting.id, instruction: '測試遮罩' });
    assert.equal(run.status, 'failed');
    assert.match(run.events.at(-1).message, /••••••••/);
    const result = run.events.find((event) => event.type === 'tool-result').result;
    assert.equal(result.count, 4);
    assert.equal(result.text, '••••••••');
    const journal = fs.readFileSync(store.conversations.filename(meeting.id), 'utf8');
    for (const serialized of [JSON.stringify(events), journal]) {
      assert.equal(serialized.includes(settings.llm.apiKey), false);
      assert.equal(serialized.includes('fixture-inline-secret'), false);
    }
  } finally {
    await agent.close();
    store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('studio-private-trace-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
