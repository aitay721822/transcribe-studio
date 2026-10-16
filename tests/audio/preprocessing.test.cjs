const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { transcribeFile } = require('../../dist/transport/transcription/file.cjs');
const { pcmWav } = require('../../dist/transport/transcription/wav.cjs');

const config = { fileUrl: 'http://localhost/audio/transcriptions', fileModel: 'local' };

async function fixture(t, seconds) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-audio-dsp-test-'));
  const priorTemp = process.env.TEMP;
  const priorTmp = process.env.TMP;
  process.env.TEMP = dir;
  process.env.TMP = dir;
  t.after(() => {
    if (priorTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = priorTemp;
    if (priorTmp === undefined) delete process.env.TMP;
    else process.env.TMP = priorTmp;
  });
  const file = path.join(dir, 'noisy.wav');
  const pcm = Buffer.alloc(seconds * 32000);
  let seed = 12345;
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff - 0.5) * 600;
    const voice = sample >= 2 * 16000 ? Math.sin((sample * 2 * Math.PI * 440) / 16000) * 4000 : 0;
    pcm.writeInt16LE(Math.round(voice + noise), sample * 2);
  }
  await fs.writeFile(file, pcmWav(pcm, 16000));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file, pcm };
}

const workspaces = async () =>
  new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('studio-audio-work-')));

test('staged background denoising reduces steady noise, preserves a voice-band tone and cleans temporary audio', async (t) => {
  const { file, pcm } = await fixture(t, 10);
  const before = await workspaces();
  const events = [];
  let processed;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    processed = Buffer.from(await options.body.get('file').arrayBuffer()).subarray(44);
    return Response.json({ text: '完成辨識' });
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    assert.equal(
      await transcribeFile(config, file, { onProgress: (event) => events.push(event) }),
      '完成辨識'
    );
  } finally {
    clearInterval(timer);
  }
  assert(ticks > 3, 'the caller event loop remains responsive during preprocessing');
  assert.deepEqual(
    [...new Set(events.map((event) => event.stage))],
    ['decode', 'denoise', 'segment', 'transcribe', 'completed']
  );
  for (const stage of ['decode', 'denoise', 'segment'])
    assert(events.some((event) => event.stage === stage && event.percent === 100));
  for (const stage of ['denoise', 'segment'])
    assert.equal(events.find((event) => event.stage === stage).seconds, 0, 'stage counters reset');
  assert.equal(processed.length, pcm.length, 'denoising preserves duration');

  function rms(bytes, start, end) {
    let power = 0;
    for (let i = start * 32000; i < end * 32000; i += 2) power += bytes.readInt16LE(i) ** 2;
    return Math.sqrt(power / ((end - start) * 16000));
  }

  assert(rms(processed, 1, 2) < rms(pcm, 1, 2) * 0.85, 'steady noise is reduced');

  function tone(bytes) {
    let sin = 0,
      cos = 0;
    for (let i = 4 * 16000; i < 8 * 16000; i++) {
      sin += bytes.readInt16LE(i * 2) * Math.sin((i * 2 * Math.PI * 440) / 16000);
      cos += bytes.readInt16LE(i * 2) * Math.cos((i * 2 * Math.PI * 440) / 16000);
    }
    return (Math.hypot(sin, cos) * 2) / (4 * 16000);
  }

  assert(tone(processed) / tone(pcm) > 0.7, 'voice-band energy is preserved');
  assert.deepEqual(await fs.readFile(file), pcmWav(pcm, 16000), 'the original file is unchanged');
  const after = await workspaces();
  assert.deepEqual(
    [...after].filter((name) => !before.has(name)),
    []
  );
});

test('cancelling during DSP stops before upload, cleans the worker workspace and emits no completion', async (t) => {
  const { file } = await fixture(t, 120);
  const before = await workspaces();
  const controller = new AbortController();
  const events = [];
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    uploads++;
    return Response.json({ text: 'late' });
  });
  await assert.rejects(
    transcribeFile(config, file, {
      signal: controller.signal,

      onProgress: (event) => {
        events.push(event);
        if (event.stage === 'denoise') controller.abort();
      },
    }),
    { name: 'AbortError' }
  );
  assert.equal(uploads, 0);
  assert(!events.some((event) => event.stage === 'completed'));
  const after = await workspaces();
  assert.deepEqual(
    [...after].filter((name) => !before.has(name)),
    []
  );
});
