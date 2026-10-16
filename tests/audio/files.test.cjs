const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const {
  transcribeFile: transcribe,
  trimOverlap,
} = require('../../dist/transport/transcription/file.cjs');

const transcribeFile = (config, file, options) =>
  transcribe(config, file, { denoise: false, ...options });

const { pcmWav } = require('../../dist/transport/transcription/wav.cjs');
const { AUDIO_FILE_LIMIT } = require('../../dist/domain/transcription.cjs');

const config = { fileUrl: 'http://localhost/audio/transcriptions', fileModel: 'local' };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-audio-preprocess-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function encode(file, seconds = 65.25) {
  const result = spawnSync(
    require('ffmpeg-static'),
    [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=sample_rate=48000',
      '-t',
      String(seconds),
      '-ac',
      '2',
      file,
    ],
    { windowsHide: true, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
}

async function wav(form) {
  const file = form.get('file');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(file.type, 'audio/wav');
  assert.equal(bytes.toString('utf8', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  assert(bytes.length <= 30 * 16000 * 2 + 44);
  return { name: file.name, pcm: bytes.subarray(44) };
}

test('large stereo audio is resampled and uploaded as ordered, bounded WAVs with the final tail', async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'large stereo.wav');
  const seconds = 70.25;
  const source = pcmWav(Buffer.alloc(seconds * 96000 * 4, 7), 96000);
  source.writeUInt16LE(2, 22);
  source.writeUInt32LE(96000 * 4, 28);
  source.writeUInt16LE(4, 32);
  assert(source.length > 25 * 1024 * 1024);
  await fs.writeFile(file, source);
  const uploads = [];
  let active = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(++active, 1, 'requests must be sequential');
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const form = await new Request('http://localhost', {
      method: 'POST',
      headers: req.headers,
      body: Buffer.concat(body),
    }).formData();
    uploads.push(await wav(form));
    assert.equal(form.get('model'), 'local');
    assert.equal(form.get('language'), 'zh');
    active--;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: `段落 ${uploads.length}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const segments = [],
    durations = [];
  const text = await transcribeFile(
    {
      ...config,
      fileUrl: `http://127.0.0.1:${server.address().port}/audio/transcriptions`,
      language: 'zh',
    },
    file,
    {
      onSegment: (s) => segments.push(s),

      onDuration: (s) => durations.push(s),
    }
  );
  assert.equal(text, '段落 1\n段落 2\n段落 3');
  assert.deepEqual(
    uploads.map((u) => u.name),
    ['large stereo-001.wav', 'large stereo-002.wav', 'large stereo-003.wav']
  );
  assert.deepEqual(
    segments.map((s) => [s.start, s.end]),
    [
      [0, 30],
      [29, 59],
      [58, 70.25],
    ]
  );
  assert.deepEqual(durations, [30, 59, 70.25]);
  assert.equal(
    uploads.reduce((sum, u) => sum + u.pcm.length, 0),
    (seconds + 2) * 16000 * 2
  );
  assert(
    uploads.every((u) => u.pcm.readInt16LE(1000) === 1799),
    'audio samples survive conversion'
  );
  assert.deepEqual(uploads[0].pcm.subarray(-32000), uploads[1].pcm.subarray(0, 32000));
  assert.deepEqual(uploads[1].pcm.subarray(-32000), uploads[2].pcm.subarray(0, 32000));
});

test('small compressed long audio is split by decoded duration; supported codecs decode before upload', async (t) => {
  const dir = await fixture(t);
  const uploads = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    uploads.push(await wav(options.body));
    return Response.json({ text: `辨識 ${uploads.length}` });
  });
  for (const extension of ['mp3', 'm4a', 'webm', 'ogg', 'flac']) {
    const file = path.join(dir, `recording.${extension}`);
    encode(file, extension === 'mp3' ? 65.25 : 1);
    assert((await fs.stat(file)).size < 2 * 1024 * 1024);
    uploads.length = 0;
    const segments = [];
    await transcribeFile(config, file, { onSegment: (s) => segments.push(s) });
    assert.equal(uploads.length, extension === 'mp3' ? 3 : 1, extension);
    assert(Math.abs(segments.at(-1).end - (extension === 'mp3' ? 65.25 : 1)) < 0.1);
  }
});

test('oversized, invalid and pre-cancelled files never upload; cancellation and service failure stop subsequent chunks', async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'source.wav');
  await fs.writeFile(file, 'invalid');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ text: 'late transcript' });
  });
  await assert.rejects(transcribeFile(config, file), /前處理失敗/);
  await fs.truncate(file, AUDIO_FILE_LIMIT + 1);
  await assert.rejects(transcribeFile(config, file), /1 GB/);
  await assert.rejects(transcribeFile(config, file, { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
  await fs.writeFile(file, pcmWav(Buffer.alloc(65 * 16000 * 2), 16000));
  const controller = new AbortController();
  const segments = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    controller.abort();
    return Response.json({ text: 'late transcript' });
  });
  await assert.rejects(
    transcribeFile(config, file, {
      signal: controller.signal,

      onSegment: (s) => segments.push(s),
    }),
    { name: 'AbortError' }
  );
  assert.equal(calls, 1);
  assert.deepEqual(segments, []);
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('secret', { status: 413 });
  });
  await assert.rejects(transcribeFile(config, file), /413/);
  assert.equal(calls, 2);
});

test('pause-aware boundaries and overlap preserve every sample, the final word and genuine repetition after a pause', async (t) => {
  const dir = await fixture(t);
  const cases = [
    {
      seconds: 40,
      pause: [27, 27.4],
      ranges: [
        [0, 27.2],
        [27.2, 40],
      ],
      overlap: false,
    },
    {
      seconds: 40,
      pause: [27, 27.1],
      ranges: [
        [0, 30],
        [29, 40],
      ],
      overlap: true,
    },
    { seconds: 30, ranges: [[0, 30]], overlap: false },
    {
      seconds: 30.05,
      ranges: [
        [0, 30],
        [29, 30.05],
      ],
      overlap: true,
    },
  ];
  for (const scenario of cases) {
    const samples = Buffer.alloc(scenario.seconds * 32000);
    for (let i = 0; i < samples.length; i += 2) samples.writeInt16LE(7000, i);
    if (scenario.pause) samples.fill(0, scenario.pause[0] * 32000, scenario.pause[1] * 32000);
    const file = path.join(dir, 'boundary.wav');
    await fs.writeFile(file, pcmWav(samples, 16000));
    const uploads = [],
      segments = [],
      durations = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      uploads.push(await wav(options.body));
      return Response.json({
        text: uploads.length === 1 ? '今天討論專案進度。' : '專案進度，接著確認時程。',
      });
    });
    const text = await transcribeFile(config, file, {
      onSegment: (s) => segments.push(s),

      onDuration: (d) => durations.push(d),
    });
    assert.deepEqual(
      segments.map((s) => [s.start, s.end]),
      scenario.ranges
    );
    assert.equal(
      durations.at(-1),
      scenario.seconds,
      'duration must not count overlapping audio twice'
    );
    for (let i = 0; i < uploads.length; i++) {
      const [start, end] = scenario.ranges[i];
      assert.deepEqual(
        uploads[i].pcm,
        samples.subarray(Math.round(start * 32000), Math.round(end * 32000))
      );
    }
    if (scenario.ranges.length > 1)
      assert.equal(
        text,
        `今天討論專案進度。\n${scenario.overlap ? '接著確認時程。' : '專案進度，接著確認時程。'}`
      );
  }
});

test('boundary text matching is conservative about whole words, short replies and uncertain wording', () => {
  assert.equal(trimOverlap('討論專案進度。', '專案進度，接著確認。'), '接著確認。');
  assert.equal(trimOverlap('Please ship it.', 'SHIP IT, tomorrow.'), 'tomorrow.');
  assert.equal(
    trimOverlap('Discuss the project.', 'projecting the budget'),
    'projecting the budget'
  );
  assert.equal(trimOverlap('We went nowhere.', 'now here is the plan'), 'now here is the plan');
  assert.equal(trimOverlap('嗯，好。', '好，繼續。'), '好，繼續。');
  assert.equal(trimOverlap('確認專案進度', '確認專案時程'), '確認專案時程');
  assert.equal(trimOverlap('專案進度。', '專案進度，專案進度需要更新。'), '專案進度需要更新。');
  assert.equal(trimOverlap('今天討論專案進度', '專案進度，-10% 是預測值'), '-10% 是預測值');
  assert.equal(trimOverlap('𠮷野專案進度。', '𠮷野專案進度，確認。'), '確認。');
});
