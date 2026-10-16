const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { transcribeAudio } = require('../../dist/transport/transcription/request.cjs');
const { HttpTranscriptionSession } = require('../../dist/transport/transcription/session.cjs');
const { createAsrSession } = require('../../dist/transport/asr.cjs');
const { validateTranscription } = require('../../dist/domain/transcription.cjs');

async function endpoint(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/custom/audio/transcriptions?deployment=test`,
  };
}

function pcm(seconds, value = 8000) {
  const b = Buffer.alloc(seconds * 16000 * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
}

async function parse(req) {
  const chunks = [];
  for await (const bytes of req) chunks.push(bytes);
  const form = await new Request('http://localhost', {
    method: 'POST',
    headers: req.headers,
    body: Buffer.concat(chunks),
  }).formData();
  return {
    model: form.get('model'),
    language: form.get('language'),
    format: form.get('response_format'),
    file: form.get('file'),
  };
}

test('HTTP file transcription uses exact custom path/query, independent credentials, MIME and multipart fields', async () => {
  let actual;
  const { server, url } = await endpoint(async (req, res) => {
    actual = {
      ...(await parse(req)),
      url: req.url,
      auth: req.headers.authorization,
      custom: req.headers['x-local'],
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '離線辨識成功' }));
  });
  try {
    assert.equal(
      await transcribeAudio(
        {
          fileUrl: url,
          fileModel: 'local-whisper',
          apiKey: 'live-secret',
          fileApiKey: 'file-secret',
          fileHeaders: { 'X-Local': 'local' },
          language: 'zh',
        },
        pcm(1),
        'sample.wav'
      ),
      '離線辨識成功'
    );
    assert.equal(actual.url, '/custom/audio/transcriptions?deployment=test');
    assert.equal(actual.auth, 'Bearer file-secret');
    assert.equal(actual.custom, 'local');
    assert.equal(actual.model, 'local-whisper');
    assert.equal(actual.language, 'zh');
    assert.equal(actual.format, 'json');
    assert.equal(actual.file.name, 'sample.wav');
    assert.equal(actual.file.type, 'audio/wav');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('HTTP capture sends standalone WAVs in FIFO order, skips silence and drains the final partial segment', async () => {
  const uploads = [],
    events = [];
  const { server, url } = await endpoint(async (req, res) => {
    const form = await parse(req);
    uploads.push(Buffer.from(await form.file.arrayBuffer()));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: `段落 ${uploads.length}` }));
  });
  try {
    const session = new HttpTranscriptionSession(
      { fileUrl: url, fileModel: 'local', fileApiKey: '', sampleRate: 16000, chunkSeconds: 2 },
      (e) => events.push(e)
    );
    await session.connect();
    assert(session.audio(pcm(2, 0)));
    assert(session.audio(pcm(3)));
    await session.close();
    assert.equal(uploads.length, 2);
    for (const wav of uploads) {
      assert.equal(wav.toString('utf8', 0, 4), 'RIFF');
      assert.equal(wav.readUInt32LE(24), 16000);
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(40), wav.length - 44);
    }
    const segments = events.filter((e) => e.type === 'segment').map((e) => e.segment);
    assert.deepEqual(
      segments.map((s) => [s.start, s.end, s.text]),
      [
        [2, 4, '段落 1'],
        [4, 5, '段落 2'],
      ]
    );
    assert(segments.every((s) => s.final && s.timing === 'approximate'));
    assert.equal(session.audio(pcm(1)), false);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('HTTP validation, error responses and cancellation avoid leaking secrets or late transcripts', async () => {
  assert.throws(
    () => validateTranscription({ fileUrl: 'ws://localhost', fileModel: 'local' }),
    /HTTP/
  );
  assert.throws(() => validateTranscription({ fileModel: 'local', fileApiKey: '' }), /API key/);
  assert.throws(
    () =>
      validateTranscription({
        fileUrl: 'http://localhost',
        fileModel: 'local',
        fileHeaders: { 'content-type': 'invalid' },
      }),
    /Content-Type/
  );
  let received, heldResponse;
  const incoming = new Promise((resolve) => {
    received = resolve;
  });
  const { server, url } = await endpoint(async (req, res) => {
    await parse(req);
    if (req.url.includes('deny')) {
      res.writeHead(401);
      res.end('file-secret');
    } else {
      heldResponse = res;
      received();
    }
  });
  try {
    await assert.rejects(
      transcribeAudio({ fileUrl: `${url}&deny=true`, fileModel: 'local' }, pcm(1), 'sample.wav'),
      (e) => e.message.includes('401') && !e.message.includes('file-secret')
    );
    const events = [],
      session = new HttpTranscriptionSession(
        { fileUrl: url, fileModel: 'local', sampleRate: 16000, chunkSeconds: 2 },
        (e) => events.push(e)
      );
    await session.connect();
    session.audio(pcm(2));
    await incoming;
    session.cancel();
    await session.close();
    heldResponse.end(JSON.stringify({ text: 'late transcript' }));
    assert.equal(events.filter((e) => e.type !== 'status').length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('HTTP capture bounds queued inference instead of accumulating audio indefinitely', async () => {
  const { server, url } = await endpoint(async (req) => {
    await parse(req);
  });
  try {
    const events = [],
      session = new HttpTranscriptionSession(
        { fileUrl: url, fileModel: 'local', sampleRate: 16000, chunkSeconds: 2 },
        (e) => events.push(e)
      );
    await session.connect();
    for (let i = 0; i < 5; i++) session.audio(pcm(2));
    await session.close();
    assert.equal(events.filter((e) => e.type === 'error').length, 1);
    assert.match(events.find((e) => e.type === 'error').message, /速度不足/);
    assert.equal(session.audio(pcm(1)), false);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test('vLLM realtime validates its model, opens generation, streams base64 PCM16 and finishes before close', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const inputs = [],
    events = [];
  server.on('connection', (ws, req) => {
    assert(!req.url.includes('intent='));
    ws.send(JSON.stringify({ type: 'session.created', id: 'session' }));
    ws.on('message', (raw) => {
      const e = JSON.parse(raw);
      inputs.push(e);
      if (e.type === 'input_audio_buffer.append')
        ws.send(JSON.stringify({ type: 'transcription.delta', delta: 'vLLM 文字' }));
      if (e.final)
        ws.send(JSON.stringify({ type: 'transcription.done', text: 'vLLM 文字完成', usage: {} }));
    });
  });
  const session = createAsrSession(
    {
      provider: 'openai',
      realtimeFlavor: 'vllm',
      url: `ws://127.0.0.1:${server.address().port}/v1/realtime`,
      model: 'local-voxtral',
      apiKey: '',
    },
    (e) => events.push(e)
  );
  try {
    await session.connect();
    assert(session.audio(pcm(1)));
    await session.close();
    assert.deepEqual(inputs.slice(0, 2), [
      { type: 'session.update', model: 'local-voxtral' },
      { type: 'input_audio_buffer.commit' },
    ]);
    assert.equal(Buffer.from(inputs[2].audio, 'base64').length, 32000);
    assert.equal(inputs.at(-1).final, true);
    const segs = events.filter((e) => e.type === 'segment').map((e) => e.segment);
    assert.equal(segs.at(-1).text, 'vLLM 文字完成');
    assert.equal(segs[0].id, segs[1].id);
    assert.equal(segs.at(-1).final, true);
  } finally {
    session.ws?.terminate();
    for (const ws of server.clients) ws.terminate();
    await new Promise((r) => server.close(r));
  }
});
