const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../dist/harness/coordinator.cjs');
const { ClaudeAdapter } = require('../dist/ai/adapters/claude.cjs');
const { Store, DEFAULTS } = require('../dist/persistence/store.cjs');
const { claudeCli } = require('./fixtures/claude-cli.cjs');

const configure = (store, backend) => {
  const s = structuredClone(DEFAULTS);
  s.llm = {
    ...s.llm,
    backend,
    model: 'test',
    apiKey: 'test',
    claudeKey: 'claude-test',
    claudeModel: 'test',
  };
  store.saveSettings(s);
};

test('execution settings accept longer budgets and separate tool/model limits without silently clamping', () => {
  const { executionLimits } = require('../dist/domain/agents/limits.cjs');

  assert.deepEqual(executionLimits({ maxSteps: 350, maxToolCalls: 900, timeoutMinutes: 60 }), {
    maxSteps: 350,
    maxToolCalls: 900,
    timeoutMinutes: 60,
  });
  assert.deepEqual(executionLimits({ maxSteps: 7 }), {
    maxSteps: 7,
    maxToolCalls: 7,
    timeoutMinutes: 30,
  });
  assert.deepEqual(executionLimits({ maxToolCalls: 0, timeoutMinutes: 0 }), {
    maxSteps: 20,
    maxToolCalls: 0,
    timeoutMinutes: 0,
  });
  for (const settings of [
    { maxSteps: 0 },
    { maxSteps: 1.5 },
    { maxToolCalls: -1 },
    { maxToolCalls: Infinity },
    { timeoutMinutes: -1 },
    { timeoutMinutes: 1441 },
    { timeoutMinutes: NaN },
  ])
    assert.throws(() => executionLimits(settings), /整數/);
});

test('configured time budget survives five minutes, aborts at its own deadline, and supports no deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const minutes of [10, 0]) {
    const store = new Store(':memory:');
    const project = store.createProject('timer');
    const meeting = store.createMeeting(project.id, 'timer');
    configure(store, 'openai');
    store.saveSettings({
      ...store.settings(),
      llm: { ...store.settings().llm, timeoutMinutes: minutes },
    });
    let ready, context;
    const entered = new Promise((resolve) => {
      ready = resolve;
    });
    const adapter = {
      id: 'openai',

      execute(ctx) {
        context = ctx;
        ready();
        return new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
        );
      },
    };
    const agent = new Agent(store, path.join(__dirname, '../skills'), () => {}, undefined, [
      adapter,
    ]);
    try {
      const pending = agent.run({ meetingId: meeting.id, instruction: '整理' });
      await entered;
      t.mock.timers.tick(300001);
      assert.equal(context.signal.aborted, false, 'five minutes is no longer a hidden cutoff');
      if (minutes) t.mock.timers.tick(300000);
      else {
        t.mock.timers.tick(24 * 60 * 60 * 1000);
        assert.equal(context.signal.aborted, false);
        agent.cancel(agent.inputState(meeting.id).activeRunId);
      }
      const run = await pending;
      assert.equal(run.status, 'cancelled');
      assert.match(run.events.at(-1).message, minutes ? /10 分鐘/ : /已停止/);
      assert.equal(
        run.events.find((event) => event.type === 'started').args.limits.timeoutMinutes,
        minutes
      );
    } finally {
      await agent.close();
      store.close();
    }
  }
});

test('tool calls have distinct ids, full paired results and errors; tool limits are independent of model turns', async () => {
  const store = new Store(':memory:');
  const project = store.createProject('trace');
  const meeting = store.createMeeting(project.id, 'trace');
  store.segment(meeting.id, {
    id: 'trace-segment',
    text: '完整 output 尾端 END',
    start: 0,
    end: 30,
    final: true,
  });
  configure(store, 'openai');
  store.saveSettings({
    ...store.settings(),
    llm: { ...store.settings().llm, maxSteps: 1, maxToolCalls: 3 },
  });
  const adapter = {
    id: 'openai',

    async execute(ctx) {
      assert.equal(ctx.maxSteps, 1);
      await Promise.all([
        ctx.tools.call('studio_read_transcript', { offset: 0, limit: 1 }),
        ctx.tools.call('studio_read_transcript', { offset: 1, limit: 1 }),
      ]);
      const invalid = await ctx.tools.call('studio_read_transcript', { limit: 1000 });
      assert.match(invalid.error, /參數/);
      await ctx.tools.call('studio_read_notes', {});
      return 'unreachable';
    },
  };
  const agent = new Agent(store, path.join(__dirname, '../skills'), () => {}, undefined, [adapter]);
  try {
    const run = await agent.run({ meetingId: meeting.id, instruction: '整理' });
    assert.equal(run.status, 'cancelled');
    assert.match(run.events.at(-1).message, /3 次/);
    const inputs = run.events.filter((event) => event.type === 'tool');
    const outputs = run.events.filter((event) => event.type === 'tool-result');
    assert.equal(inputs.length, 3);
    assert.equal(new Set(inputs.map((event) => event.callId)).size, 3);
    for (const input of inputs) {
      const output = outputs.find((event) => event.callId === input.callId);
      assert(output && output.durationMs >= 0 && output.timestamp && input.timestamp);
    }
    assert.match(outputs[0].result.segments[0].text, /END$/);
    assert.equal(outputs.at(-1).status, 'error');
    assert.deepEqual(
      store.conversations.runs(meeting.id)[0].events,
      JSON.parse(JSON.stringify(run.events))
    );
  } finally {
    await agent.close();
    store.close();
  }
});

test('trace pairing supports concurrent same-name calls and old journals; coverage counts unique returned segments', () => {
  const { toolCallTraces, transcriptCoverage } = require('../dist/domain/agents/trace.cjs');

  const events = [
    { type: 'tool', name: 'studio_read_transcript', callId: 'a', args: { offset: 0, limit: 1 } },
    { type: 'tool', name: 'studio_read_transcript', callId: 'b', args: { offset: 1, limit: 1 } },
    {
      type: 'tool-result',
      name: 'studio_read_transcript',
      callId: 'b',
      result: { total: 2, segments: [{ id: 'b' }] },
    },
    {
      type: 'tool-result',
      name: 'studio_read_transcript',
      callId: 'a',
      result: { total: 2, segments: [{ id: 'a' }] },
    },
    { type: 'tool', name: 'studio_read_transcript', args: { limit: 1, offset: 0 } },
    {
      type: 'tool-result',
      name: 'studio_read_transcript',
      result: { total: 2, segments: [{ id: 'a' }] },
    },
  ];
  const calls = toolCallTraces(events);
  assert.equal(calls[0].output.result.segments[0].id, 'a');
  assert.equal(calls[1].output.result.segments[0].id, 'b');
  assert.equal(calls[2].repetition, 2);
  assert.deepEqual(transcriptCoverage(calls), { received: 2, total: 2 });
});
test('abstract coordinator dispatches every backend and shares tool validation and versioned proposals', async () => {
  const store = new Store(':memory:');
  const p = store.createProject('project');
  const previous = store.createMeeting(p.id, '先前決議');
  store.updateMeeting(previous.id, { notes: '上次決議採用 WebSocket 串流' }, 0);
  const outsideProject = store.createProject('其他專案');
  const outsideMeeting = store.createMeeting(outsideProject.id, '不可讀取');
  const m = store.createMeeting(p.id, 'meeting');
  store.segment(m.id, { id: 'seg1', text: '確認決議', final: true });
  const adapters = ['openai', 'codex', 'claude'].map((id) => ({
    id,

    async execute(ctx) {
      const previousMeetings = await ctx.tools.call('studio_search_meetings', {
        query: 'WebSocket',
        limit: 20,
      });
      assert.equal(previousMeetings.total, 1);
      assert.equal(previousMeetings.meetings[0].meetingId, previous.id);
      const previousNotes = await ctx.tools.call('studio_read_meeting', {
        meetingId: previous.id,
        offset: 0,
        limit: 5,
      });
      assert.equal(previousNotes.notes, '上次決議採');
      assert.equal(previousNotes.nextOffset, 5);
      assert.match(previousNotes.citation, /:v1\]/);
      assert((await ctx.tools.call('studio_read_meeting', { meetingId: outsideMeeting.id })).error);
      assert((await ctx.tools.call('studio_read_meeting', { meetingId: m.id })).error);
      const result = await ctx.tools.call('studio_read_transcript', { query: '決議' });
      assert.equal(result.total, 1);
      const invalid = await ctx.tools.call('studio_read_transcript', { limit: 1000 });
      assert.match(invalid.error, /參數/);
      ctx.bindSession({ id: `${id}-session`, fingerprint: 'fp' });
      return `# ${id}`;
    },
  }));
  const events = [];
  const agent = new Agent(
    store,
    path.join(__dirname, '../skills'),
    (e) => events.push(e),
    undefined,
    adapters
  );
  for (const id of ['openai', 'codex', 'claude']) {
    configure(store, id);
    const run = await agent.run({ meetingId: m.id, instruction: '整理' });
    assert.equal(run.backend, id);
    assert.equal(run.status, 'proposed');
    assert.equal(run.version, 0);
    assert.equal(store.get('meetings', m.id).notes, '');
    assert.equal(store.get('meetings', m.id).agentSessions[id].id, `${id}-session`);
  }
  assert.equal(events.filter((e) => e.type === 'proposal').length, 3);
  await agent.close();
  store.close();
});
test('coordinator queues during startup and shutdown preserves pending input in JSONL', async () => {
  const store = new Store(':memory:');
  const p = store.createProject('project');
  const m = store.createMeeting(p.id, 'meeting');
  configure(store, 'openai');
  const adapter = {
    id: 'openai',

    async execute(ctx) {
      return new Promise((resolve, reject) =>
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
      );
    },
  };
  const agent = new Agent(store, path.join(__dirname, '../skills'), () => {}, undefined, [adapter]);
  const job = agent.run({ meetingId: m.id, instruction: '整理' });
  const queued = agent.run({ meetingId: m.id, instruction: '另一份' });
  assert.equal(agent.inputState(m.id).queued.length, 1);
  await new Promise((r) => setTimeout(r, 100));
  await agent.close();
  assert.equal((await job).status, 'cancelled');
  assert.equal((await queued).status, 'queued');
  assert.equal(store.list('runs')[0].status, 'cancelled');
  store.close();
});
test('real Claude CLI -p executes the meeting MCP gateway against a local mock Anthropic API', {
  timeout: 60000,
}, async () => {
  const { createMock } = require('./fixtures/claude-mock-api.cjs');

  const mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const adapter = new ClaudeAdapter((file, args, cwd, env) => {
    const { ClaudeProcess } = require('../dist/transport/claude/process.cjs');

    return new ClaudeProcess(file, args, cwd, {
      ...env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.server.address().port}`,
    });
  });
  const store = new Store(':memory:');
  const p = store.createProject('local');
  const m = store.createMeeting(p.id, 'local');
  configure(store, 'claude');
  store.saveSettings({
    ...store.settings(),
    llm: { ...store.settings().llm, claudePath: claudeCli() },
  });
  const agent = new Agent(
    store,
    path.join(__dirname, '../skills'),
    () => {},
    fs.mkdtempSync(path.join(os.tmpdir(), 'studio-claude-real-')),
    [adapter]
  );
  try {
    const run = await agent.run({ meetingId: m.id, instruction: '整理紀錄' });
    assert.equal(run.status, 'proposed', JSON.stringify(run.events));
    assert.match(run.notes, /Claude 本機測試/);
    assert(
      run.events.some((e) => e.type === 'tool' && e.name === 'studio_read_notes'),
      JSON.stringify({
        events: run.events,
        requests: mock.bodies.map((b) => ({ model: b.model, tools: b.tools?.map((t) => t.name) })),
      })
    );
    assert(mock.requests >= 2);
    const session = store.get('meetings', m.id).agentSessions.claude.id;
    const continued = await agent.run({ meetingId: m.id, instruction: 'CONTINUE_SAME_MEETING' });
    assert.equal(continued.status, 'proposed', JSON.stringify(continued.events));
    assert.equal(store.get('meetings', m.id).agentSessions.claude.id, session);
    assert(
      mock.bodies.some((body) => JSON.stringify(body.messages).includes('CONTINUE_SAME_MEETING'))
    );
  } finally {
    await agent.close();
    store.close();
    mock.server.closeAllConnections();
    await new Promise((r) => mock.server.close(r));
  }
});
