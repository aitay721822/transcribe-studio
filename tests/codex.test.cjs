const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Agent } = require('../dist/harness/coordinator.cjs');
const { Store, DEFAULTS } = require('../dist/persistence/store.cjs');

function sendResponse(res, output) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let sequence = 0;
  const response = {
    id: `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: 'local-test',
    status: 'in_progress',
    output: [],
  };

  const emit = (type, data) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`
    );

  emit('response.created', { response });
  for (const [index, item] of output.entries()) {
    emit('response.output_item.added', {
      output_index: index,
      item: {
        ...item,
        status: 'in_progress',
        ...(item.type === 'message' ? { content: [] } : { arguments: '' }),
      },
    });
    if (item.type === 'message') {
      emit('response.content_part.added', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      emit('response.output_text.delta', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: item.content[0].text,
      });
      emit('response.output_text.done', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        text: item.content[0].text,
      });
      emit('response.content_part.done', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: item.content[0],
      });
    } else {
      emit('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      });
      emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
    }
    emit('response.output_item.done', { output_index: index, item });
  }
  emit('response.completed', {
    response: {
      ...response,
      status: 'completed',
      output,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
}

for (const holdAt of [1, 2])
  test('real Codex app-server steer during inference ' +
    holdAt +
    ' uses the live turn and retains added input', { timeout: 30000 }, async (t) => {
    const cli = path.join(process.env.LOCALAPPDATA || '', 'Programs/OpenAI/Codex/bin/codex.exe');
    if (!fs.existsSync(cli)) {
      t.skip('Codex CLI is not installed');
      return;
    }
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let entered;
    const held = new Promise((r) => {
      entered = r;
    });
    const bodies = [];
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw = `${raw}${c}`;
      const body = JSON.parse(raw);
      bodies.push(body);
      if (bodies.length === holdAt) {
        entered();
        await gate;
      }
      const steered = JSON.stringify(body.input).includes('CODEX_STEER_INCLUDE_ACTIONS');
      sendResponse(
        res,
        bodies.length === 1
          ? [
              {
                type: 'function_call',
                id: 'fc_steer',
                call_id: 'steer_tool',
                name: 'studio_read_notes',
                arguments: '{}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: `msg_steer_${bodies.length}`,
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      notes: steered ? '# added actions' : '# initial proposal',
                    }),
                    annotations: [],
                  },
                ],
              },
            ]
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const store = new Store(':memory:');
    const project = store.createProject('steer');
    const meeting = store.createMeeting(project.id, 'steer');
    const settings = structuredClone(DEFAULTS);
    Object.assign(settings.llm, {
      backend: 'codex',
      codexPath: cli,
      model: 'test',
      apiKey: 'test',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    });
    store.saveSettings(settings);
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
      path.join(__dirname, '../skills'),
      () => {},
      fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codex-steer-')),
      undefined,
      { load: async (request) => (request.images || []).map(() => image) }
    );
    try {
      const job = agent.run({
        meetingId: meeting.id,
        instruction: 'first request',
        images: [image],
      });
      await held;
      const active = agent.inputState(meeting.id).activeRunId;
      const submission = await agent.submit(
        { meetingId: meeting.id, instruction: 'CODEX_STEER_INCLUDE_ACTIONS', images: [image] },
        'steer',
        active
      );
      assert.equal(submission.disposition, 'steered');
      release();
      const run = await job;
      assert.equal(run.status, 'proposed', JSON.stringify(run.events));
      assert.equal(run.notes, '# added actions');
      assert(run.turnId);
      assert(
        bodies.some(
          (body) =>
            body.input
              .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
              .filter((part) => part.type === 'input_image').length >= 2
        ),
        'initial and steering images reach the real Codex provider request'
      );
      assert(
        bodies.some((body) => JSON.stringify(body.input).includes('CODEX_STEER_INCLUDE_ACTIONS'))
      );
    } finally {
      release();
      await agent.close();
      store.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
test('real optional Codex app-server runs dynamic meeting tools and resumes a persisted thread against local mock API', {
  timeout: 60000,
}, async (t) => {
  const cli = path.join(process.env.LOCALAPPDATA || '', 'Programs/OpenAI/Codex/bin/codex.exe');
  if (!fs.existsSync(cli)) {
    t.skip('Codex CLI is not installed');
    return;
  }
  let requests = 0;
  let sawResult = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw = `${raw}${c}`;
    const body = JSON.parse(raw);
    requests++;
    if (requests === 1)
      sendResponse(res, [
        {
          type: 'function_call',
          id: 'fc1',
          call_id: 'call1',
          name: 'studio_read_transcript',
          arguments: '{}',
          status: 'completed',
        },
      ]);
    else {
      sawResult ||= body.input.some(
        (i) => i.type === 'function_call_output' && i.output.includes('seg1')
      );
      sendResponse(res, [
        {
          type: 'message',
          id: `msg${requests}`,
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              annotations: [],
              text: JSON.stringify({ notes: '# Codex 本機測試\n確認決議 [seg1]' }),
            },
          ],
        },
      ]);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codex-'));
  const store = new Store(path.join(dir, 'studio.sqlite'));
  const p = store.createProject('local');
  const m = store.createMeeting(p.id, 'meeting');
  store.segment(m.id, { id: 'seg1', text: '確認決議', final: true });
  const settings = structuredClone(DEFAULTS);
  settings.llm = {
    ...settings.llm,
    backend: 'codex',
    codexPath: cli,
    model: 'local-test',
    apiKey: 'local-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  };
  store.saveSettings(settings);
  const agent = new Agent(
    store,
    path.join(__dirname, '../skills'),
    () => {},
    path.join(dir, 'runtime')
  );
  try {
    const first = await agent.run({ meetingId: m.id, instruction: '整理決議' });
    assert.equal(first.status, 'proposed', JSON.stringify(first.events));
    assert(sawResult);
    assert.equal(store.get('meetings', m.id).notes, '');
    const second = await agent.run({ meetingId: m.id, instruction: '再整理' });
    assert.equal(second.status, 'proposed', JSON.stringify(second.events));
    assert.equal(second.threadId, first.threadId);
  } finally {
    await agent.close();
    store.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
