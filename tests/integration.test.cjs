const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { AsrSession } = require('../dist/transport/asr.cjs');
const { Agent } = require('../dist/harness/coordinator.cjs');
const { Store, DEFAULTS } = require('../dist/persistence/store.cjs');

test('WebSocket adapter sends binary PCM and receives custom transcript', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  let bytes;
  wss.on('connection', (ws) =>
    ws.on('message', (raw, binary) => {
      bytes = { raw, binary };
      ws.send(JSON.stringify({ id: '1', text: '測試會議', final: true }));
    })
  );
  let resolve;
  const received = new Promise((r) => (resolve = r));
  const asr = new AsrSession(
    { ...DEFAULTS.asr, provider: 'websocket', url: `ws://127.0.0.1:${wss.address().port}` },
    (e) => {
      if (e.type === 'segment') resolve(e.segment);
    }
  );
  try {
    await asr.connect();
    asr.audio(new Uint8Array([0, 1, 2, 3]));
    const seg = await received;
    assert.equal(bytes.binary, true);
    assert.equal(bytes.raw.length, 4);
    assert.equal(seg.text, '測試會議');
  } finally {
    await asr.close();
    await new Promise((r) => wss.close(r));
  }
});
test('OpenAI ASR waits for session configuration, uses transcription intent and drains final output', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  let requestUrl, sessionConfig, pcm;
  wss.on('connection', (ws, req) => {
    requestUrl = req.url;
    assert.equal(req.headers.authorization, 'Bearer test-key');
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'session.update') {
        sessionConfig = data.session;
        setTimeout(() => ws.send(JSON.stringify({ type: 'session.updated' })), 100);
      }
      if (data.type === 'input_audio_buffer.append') pcm = Buffer.from(data.audio, 'base64');
      if (data.type === 'input_audio_buffer.commit')
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: 'final',
                transcript: '最後一句也已保留',
              })
            ),
          150
        );
    });
  });
  const events = [];
  const stream = new AsrSession(
    {
      ...DEFAULTS.asr,
      provider: 'openai',
      apiKey: 'test-key',
      url: `ws://127.0.0.1:${wss.address().port}`,
    },
    (e) => events.push(e)
  );
  try {
    const pending = stream.connect();
    assert.equal(stream.ready, false);
    assert.equal(stream.audio(new ArrayBuffer(4800)), false);
    await pending;
    assert.match(requestUrl, /intent=transcription/);
    assert.equal(sessionConfig.type, 'transcription');
    assert.equal(sessionConfig.audio.input.format.rate, 24000);
    assert.equal(stream.audio(new Uint8Array(4800)), true);
    await stream.close();
    assert.equal(pcm.length, 4800);
    assert.equal(events.find((e) => e.type === 'segment').segment.text, '最後一句也已保留');
    assert.equal(stream.pendingCommits, 0);
  } finally {
    await stream.close();
    await new Promise((r) => wss.close(r));
  }
});
test('agent executes function calls and returns a versioned proposal without mutating notes', async () => {
  let requests = 0;
  let lastInput;
  let previousId;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body = `${body}${chunk}`;
    const data = JSON.parse(body);
    lastInput = data.input;
    requests++;
    res.setHeader('Content-Type', 'application/json');

    const toolArguments = () => {
      if (requests === 1) {
        return { query: '決議' };
      }
      if (requests === 2) {
        return { query: '既有方案' };
      }
      return { meetingId: previousId };
    };

    res.end(
      JSON.stringify(
        requests <= 3
          ? {
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  call_id: `call${requests}`,
                  name: ['studio_read_transcript', 'studio_search_meetings', 'studio_read_meeting'][
                    requests - 1
                  ],
                  arguments: JSON.stringify(toolArguments()),
                },
              ],
            }
          : {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text:
                        '# 會議紀錄\n決議：下週上線 [seg1]\n背景：沿用既有方案 [會議:' +
                        previousId +
                        ':v1]',
                    },
                  ],
                },
              ],
            }
      )
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const store = new Store(':memory:');
  const p = store.createProject('專案');
  const previous = store.createMeeting(p.id, '先前會議');
  previousId = previous.id;
  store.updateMeeting(previousId, { notes: '既有方案採用串流辨識' }, 0);
  const m = store.createMeeting(p.id, '會議');
  store.segment(m.id, { id: 'seg1', text: '決議下週上線', final: true });
  const settings = structuredClone(DEFAULTS);
  settings.llm = {
    apiKey: 'local-test',
    model: 'test',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    maxSteps: 4,
  };
  store.saveSettings(settings);
  const events = [];
  const agent = new Agent(store, path.join(__dirname, '../skills'), (e) => events.push(e));
  try {
    const run = await agent.run({ meetingId: m.id, instruction: '整理決議' });
    assert.equal(run.status, 'proposed');
    assert.equal(run.version, 0);
    assert.match(run.notes, /下週上線/);
    assert(lastInput.some((i) => i.type === 'function_call_output' && i.output.includes('seg1')));
    assert(
      lastInput.some(
        (i) => i.type === 'function_call_output' && i.output.includes('既有方案採用串流辨識')
      )
    );
    assert.match(run.notes, new RegExp(previousId));
    assert.equal(store.get('meetings', m.id).notes, '');
    assert(events.some((e) => e.type === 'tool'));
  } finally {
    store.close();
    await new Promise((r) => server.close(r));
  }
});
test('MCP stdio discovery, approved call, schema validation and tool output reach model', async () => {
  let count = 0;
  let toolResult;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body = `${body}${c}`;
    const data = JSON.parse(body);
    count++;
    res.setHeader('Content-Type', 'application/json');
    if (count === 1) {
      const tool = data.tools.find((t) => t.name.startsWith('studio_mcp_'));
      assert(tool);
      res.end(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'mcp1',
              name: tool.name,
              arguments: '{"query":"meeting"}',
            },
          ],
        })
      );
    } else {
      toolResult = data.input.find((i) => i.type === 'function_call_output');
      res.end(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '# MCP 驗證\n紀錄完成' }],
            },
          ],
        })
      );
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const store = new Store(':memory:');
  const p = store.createProject('MCP');
  const m = store.createMeeting(p.id, 'MCP 會議');
  const s = structuredClone(DEFAULTS);
  s.llm = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: 'test',
    apiKey: 'test',
    maxSteps: 4,
  };
  s.mcp = [
    {
      name: 'test',
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures/mcp-server.cjs')],
      enabled: true,
    },
  ];
  store.saveSettings(s);
  let approvals = 0;
  let agent;
  agent = new Agent(store, path.join(__dirname, '../skills'), (e) => {
    if (e.type === 'approval') {
      approvals++;
      setImmediate(() => agent.approve(e.id, true));
    }
  });
  try {
    const run = await agent.run({ meetingId: m.id, instruction: '使用 MCP 整理' });
    assert.equal(run.status, 'proposed');
    assert.equal(approvals, 2);
    assert.match(toolResult.output, /MCP context for meeting/);
  } finally {
    store.close();
    await new Promise((r) => server.close(r));
  }
});
test('agent cancellation aborts an in-flight model request', async () => {
  let entered;
  const waiting = new Promise((r) => (entered = r));
  const server = http.createServer(async (req) => {
    for await (const _ of req) {
    }
    entered();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const store = new Store(':memory:');
  const p = store.createProject('取消');
  const m = store.createMeeting(p.id, '取消會議');
  const s = structuredClone(DEFAULTS);
  s.llm = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: 'test',
    apiKey: 'test',
    maxSteps: 4,
  };
  store.saveSettings(s);
  const events = [];
  const agent = new Agent(store, path.join(__dirname, '../skills'), (e) => events.push(e));
  try {
    const pending = agent.run({ meetingId: m.id, instruction: '整理' });
    await waiting;
    agent.cancel(events.find((e) => e.type === 'started').runId);
    const run = await pending;
    assert.equal(run.status, 'cancelled');
    assert.equal(agent.runs.size, 0);
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
