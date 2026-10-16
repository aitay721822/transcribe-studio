const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Agent } = require('../../dist/harness/coordinator.cjs');
const { OpenAiAdapter } = require('../../dist/ai/adapters/openai.cjs');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');

const bundled = path.join(__dirname, '../../skills');

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition timed out');
}

function fixture(filename = ':memory:') {
  const store = new Store(filename);
  const settings = structuredClone(DEFAULTS);
  settings.llm.apiKey = 'local-test';
  settings.llm.model = 'local-test';
  store.saveSettings(settings);
  const project = store.createProject('queue');
  const meeting = store.createMeeting(project.id, 'queue');
  return { store, meeting };
}

test('FIFO runs are isolated by meeting and refresh notes/version at execution', async (t) => {
  const { store, meeting } = fixture();
  const other = store.createMeeting(meeting.projectId, 'other');
  const started = [];
  const gates = [];
  const agent = new Agent(store, bundled, () => {}, undefined, [
    {
      id: 'openai',

      async execute(ctx) {
        started.push({
          instruction: ctx.request.instruction,
          notes: ctx.meeting.notes,
          version: ctx.meeting.version,
        });
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        return `# ${ctx.request.instruction}`;
      },
    },
  ]);
  t.after(async () => {
    gates.forEach((g) => g.resolve());
    await agent.close();
    store.close();
  });
  const first = agent.run({ meetingId: meeting.id, instruction: 'one' });
  const second = agent.run({ meetingId: meeting.id, instruction: 'two' });
  const third = agent.run({ meetingId: meeting.id, instruction: 'three' });
  const parallel = agent.run({ meetingId: other.id, instruction: 'parallel' });
  await until(() => gates.length === 2);
  assert.deepEqual(started.map((s) => s.instruction).sort(), ['one', 'parallel']);
  store.updateMeeting(meeting.id, { notes: 'edited during first run' }, 0);
  gates[0].resolve();
  gates[1].resolve();
  await first;
  await parallel;
  await until(() => gates.length === 3);
  assert.deepEqual(started[2], {
    instruction: 'two',
    notes: 'edited during first run',
    version: 1,
  });
  gates[2].resolve();
  await second;
  await until(() => gates.length === 4);
  gates[3].resolve();
  await third;
  assert.equal(agent.inputState(meeting.id).queued.length, 0);
});

test('steer validates active id, journals acceptance, and requeues a rejected completion race', async (t) => {
  const { store, meeting } = fixture();
  const gate = deferred();
  let ctx;
  let accept = true;
  let executions = 0;
  const agent = new Agent(store, bundled, () => {}, undefined, [
    {
      id: 'openai',

      async execute(context) {
        executions++;
        ctx = context;
        ctx.bindSteer(async (text) => {
          assert.match(text, /selected/);
          return accept;
        });
        if (executions === 1) await gate.promise;
        return '# result';
      },
    },
  ]);
  t.after(async () => {
    gate.resolve();
    await agent.close();
    store.close();
  });
  const first = agent.run({ meetingId: meeting.id, instruction: 'first' });
  await until(() => ctx);
  const activeId = agent.inputState(meeting.id).activeRunId;
  await assert.rejects(
    agent.submit({ meetingId: meeting.id, instruction: 'wrong' }, 'steer', 'wrong-id'),
    /工作已改變/
  );
  const request = { meetingId: meeting.id, instruction: 'steer', selection: 'selected' };
  assert.equal((await agent.submit(request, 'steer', activeId)).disposition, 'steered');
  assert.equal(agent.inputState(meeting.id).queued.length, 0);
  assert(store.list('runs').some((r) => r.status === 'steered'));
  accept = false;
  assert.equal((await agent.submit(request, 'steer', activeId)).disposition, 'queued');
  assert.equal(agent.inputState(meeting.id).queued.length, 1);
  gate.resolve();
  await first;
  await until(() => executions === 2 && !agent.inputState(meeting.id).activeRunId);
  assert(store.list('runs').some((r) => r.events.some((e) => e.type === 'steer-rejected')));
});

test('stop pauses queue; remove and restart/resume preserve JSONL input without auto execution', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-input-'));
  const filename = path.join(directory, 'studio.sqlite');
  const { store, meeting } = fixture(filename);
  let ctx;
  const agent = new Agent(store, bundled, () => {}, undefined, [
    {
      id: 'openai',

      async execute(context) {
        ctx = context;
        await new Promise((resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
        );
      },
    },
  ]);
  const first = agent.run({ meetingId: meeting.id, instruction: 'first' });
  await until(() => ctx);
  const cancelled = await agent.submit({ meetingId: meeting.id, instruction: 'remove me' });
  const pending = await agent.submit({ meetingId: meeting.id, instruction: 'persist me' });
  agent.cancel(cancelled.id);
  agent.cancel(agent.inputState(meeting.id).activeRunId);
  await first;
  assert.equal(agent.inputState(meeting.id).paused, true);
  await agent.close();
  store.close();
  const reopened = new Store(filename);
  reopened.recover();
  let calls = 0;
  const restored = new Agent(reopened, bundled, () => {}, undefined, [
    {
      id: 'openai',

      async execute(ctx) {
        calls++;
        return `# ${ctx.request.instruction}`;
      },
    },
  ]);
  t.after(async () => {
    await restored.close();
    reopened.close();
  });
  assert.equal(calls, 0);
  assert.deepEqual(
    restored.inputState(meeting.id).queued.map((r) => r.id),
    [pending.id]
  );
  assert.equal(restored.inputState(meeting.id).paused, true);
  restored.resume(meeting.id);
  await until(() => calls === 1 && !restored.inputState(meeting.id).activeRunId);
  assert.equal(reopened.get('runs', pending.id).status, 'proposed');
});

test('stopping during a pending steer preserves input even when a late acknowledgement accepts it', async (t) => {
  const { store, meeting } = fixture();
  const entered = deferred();
  const reply = deferred();
  let context;
  const agent = new Agent(store, bundled, () => {}, undefined, [
    {
      id: 'openai',

      async execute(ctx) {
        context = ctx;
        ctx.bindSteer(async () => {
          entered.resolve();
          await reply.promise;
          return true;
        });
        await new Promise((resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
        );
      },
    },
  ]);
  t.after(async () => {
    reply.resolve();
    await agent.close();
    store.close();
  });
  const job = agent.run({ meetingId: meeting.id, instruction: 'initial' });
  await until(() => context);
  const active = agent.inputState(meeting.id).activeRunId;
  const steer = agent.submit(
    { meetingId: meeting.id, instruction: 'pending steer' },
    'steer',
    active
  );
  await entered.promise;
  const state = agent.inputState(meeting.id);
  assert.equal(state.queued[0].steering, true);
  assert.throws(() => agent.cancel(state.queued[0].id), /正在傳送/);
  agent.cancel(active);
  reply.resolve();
  assert.equal((await steer).disposition, 'queued');
  assert.equal((await job).status, 'cancelled');
  assert.equal(agent.inputState(meeting.id).paused, true);
  assert.equal(agent.inputState(meeting.id).queued.length, 1);
  assert.equal(store.list('runs').filter((r) => r.status === 'steered').length, 0);
});

test('OpenAI consumes steer at the next request boundary even when the in-flight response is final', async (t) => {
  const { store, meeting } = fixture();
  const entered = deferred();
  const release = deferred();
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw = `${raw}${chunk}`;
    bodies.push(JSON.parse(raw));
    if (bodies.length === 1) {
      entered.resolve();
      await release.promise;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `# final ${bodies.length}` }],
          },
        ],
      })
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const settings = store.settings();
  settings.llm.baseUrl = `http://127.0.0.1:${server.address().port}`;
  store.saveSettings(settings);
  const agent = new Agent(store, bundled, () => {}, undefined, [new OpenAiAdapter()]);
  t.after(async () => {
    release.resolve();
    await agent.close();
    store.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const job = agent.run({ meetingId: meeting.id, instruction: 'first' });
  await entered.promise;
  const activeId = agent.inputState(meeting.id).activeRunId;
  assert.equal(
    (
      await agent.submit(
        { meetingId: meeting.id, instruction: 'include action items' },
        'steer',
        activeId
      )
    ).disposition,
    'steered'
  );
  release.resolve();
  const run = await job;
  assert.equal(run.notes, '# final 2');
  assert.equal(bodies.length, 2);
  assert(
    bodies[1].input.some((i) => i.role === 'user' && i.content.includes('include action items'))
  );
});
