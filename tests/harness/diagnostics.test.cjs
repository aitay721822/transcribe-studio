const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { WebSocketServer } = require('ws');
const { DEFAULTS } = require('../../dist/persistence/store.cjs');
const {
  connectionSettings,
  diagnosticError,
} = require('../../dist/services/diagnostics/settings.cjs');
const { AsrConnectionTests } = require('../../dist/services/diagnostics/asr.cjs');
const { testAgent } = require('../../dist/services/diagnostics/agent.cjs');

test('PCM worklet flush emits the final short audio frame once before acknowledging', async () => {
  const vm = require('node:vm'),
    source = await fs.readFile(path.join(__dirname, '../../dist/ui/audio/pcm-worklet.js'), 'utf8');
  let Processor;
  const sent = [];
  vm.runInNewContext(source, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { postMessage: (value) => sent.push(value) };
    },

    registerProcessor: (_name, value) => {
      Processor = value;
    },
  });
  const processor = new Processor({ processorOptions: { rate: 24000 } });
  processor.process([[new Float32Array(256).fill(0.25)]]);
  assert.equal(sent.length, 0);
  processor.port.onmessage({ data: { flush: true } });
  assert(sent[0].audio.byteLength > 0 && sent[0].audio.byteLength < 4800);
  assert.equal(new Int16Array(sent[0].audio)[0], Math.round(0.25 * 32767));
  assert.equal(sent[1].flushed, true);
  processor.port.onmessage({ data: { flush: true } });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].flushed, true);
});

test('connection drafts resolve stored masked keys without mutation and redact provider errors', () => {
  const saved = structuredClone(DEFAULTS);
  saved.llm.apiKey = 'saved-model-secret';
  saved.llm.claudeKey = 'saved-claude-secret';
  saved.asr.apiKey = 'saved-asr-secret';
  const before = JSON.stringify(saved),
    draft = {
      llm: { apiKey: '••••••••', claudeKey: '••••••••', model: 'draft-model' },
      asr: { apiKey: '••••••••', headers: { Authorization: 'draft-header-secret' } },
    };
  const resolved = connectionSettings(draft, saved);
  assert.equal(resolved.llm.apiKey, saved.llm.apiKey);
  assert.equal(resolved.llm.claudeKey, saved.llm.claudeKey);
  assert.equal(resolved.asr.apiKey, saved.asr.apiKey);
  assert.equal(resolved.llm.model, 'draft-model');
  assert.equal(JSON.stringify(saved), before);
  assert.equal(draft.llm.apiKey, '••••••••');
  const error = diagnosticError(
    new Error('saved-model-secret saved-asr-secret draft-header-secret saved-claude-secret'),
    resolved
  );
  assert.equal(error, '•••••••• •••••••• •••••••• ••••••••');
  assert.throws(() => connectionSettings({ asr: { headers: ['bad'] } }, saved), /headers/);
});

test('ASR tests stream audio, normalize final words, reject oversized chunks and release on failure/cancel', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const events = [],
    tests = new AsrConnectionTests((id, event) => events.push({ id, ...event }));
  server.on('connection', (socket) =>
    socket.on('message', () =>
      socket.send(JSON.stringify({ id: 'seg', text: '裝置辨識文字', final: true }))
    )
  );
  const settings = structuredClone(DEFAULTS);
  settings.asr.provider = 'websocket';
  settings.asr.url = `ws://127.0.0.1:${server.address().port}`;
  try {
    const result = await tests.start('first', settings);
    assert.equal(result.apiKey, undefined);
    assert.equal(result.provider, 'websocket');
    assert.throws(() => tests.audio('first', new ArrayBuffer(256001)), /過大/);
    assert.equal(tests.audio('first', new Int16Array(2400).buffer), true);
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'segment'); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(events.find((e) => e.type === 'segment').segment.text, '裝置辨識文字');
    await tests.stop('first');
    assert.equal(tests.audio('first', new ArrayBuffer(10)), false);
    settings.asr.url = 'ws://127.0.0.1:1';
    await assert.rejects(tests.start('fail', settings));
    settings.asr.url = `ws://127.0.0.1:${server.address().port}`;
    await tests.start('again', settings);
    await tests.close();
    assert.equal(tests.audio('again', new ArrayBuffer(10)), false);
  } finally {
    await tests.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((r) => server.close(r));
  }
});

test('agent connection tests select every adapter with no workspace/tools/sessions and remove isolated runtime files', async () => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-agent-connection-')),
    calls = [];
  const adapters = ['openai', 'codex', 'claude'].map((id) => ({
    id,

    async execute(ctx) {
      assert.deepEqual(ctx.tools.specs(), []);
      assert.deepEqual(ctx.project.roots, []);
      assert.equal(ctx.skills.length, 0);
      assert.equal(ctx.meeting.agentSessions, undefined);
      assert.equal(ctx.settings.mcp.length, 0);
      await fs.mkdir(ctx.runtimeDir, { recursive: true });
      await fs.writeFile(path.join(ctx.runtimeDir, 'probe.txt'), 'test');
      calls.push(id);
      ctx.bindSession({ id: 'unpersisted', fingerprint: 'unpersisted' });
      return '連線測試成功';
    },
  }));
  try {
    for (const backend of ['openai', 'codex', 'claude']) {
      const settings = structuredClone(DEFAULTS);
      settings.llm = {
        ...settings.llm,
        backend,
        apiKey: 'test',
        model: 'test',
        claudeKey: 'test',
        claudeModel: 'test',
      };
      const result = await testAgent(settings, runtime, new AbortController(), () => {}, adapters);
      assert.equal(result.reply, '連線測試成功');
      assert.equal(result.backend, backend);
      assert.deepEqual(await fs.readdir(path.join(runtime, 'connection-tests')), []);
    }
    assert.deepEqual(calls, ['openai', 'codex', 'claude']);
  } finally {
    await fs.rm(runtime, { recursive: true, force: true });
  }
});

test('agent model connection performs a real HTTP inference and aborts an unfinished request', async () => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-model-test-'));
  let seen;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw = `${raw}${c}`;
    seen = { authorization: req.headers.authorization, body: JSON.parse(raw) };
    if (req.url.includes('slow')) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '連線成功' }] }],
      })
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const settings = structuredClone(DEFAULTS);
    settings.llm = {
      ...settings.llm,
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    };
    assert.equal(
      (await testAgent(settings, runtime, new AbortController(), () => {})).reply,
      '連線成功'
    );
    assert.equal(seen.authorization, 'Bearer test-key');
    assert.equal(seen.body.model, 'test-model');
    assert.deepEqual(seen.body.tools, []);
    settings.llm.baseUrl = `${settings.llm.baseUrl}${'/slow'}`;
    const controller = new AbortController();
    const promise = testAgent(settings, runtime, controller, () => {});
    setTimeout(() => controller.abort(new Error('已取消測試')), 30);
    await assert.rejects(promise, /取消/);
    assert.deepEqual(
      await fs.readdir(path.join(runtime, 'connection-tests')).catch((e) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      }),
      []
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(runtime, { recursive: true, force: true });
  }
});
