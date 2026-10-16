const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../../dist/persistence/store.cjs');
const { AsrTaskService } = require('../../dist/services/asr/tasks.cjs');
const { pcmWav } = require('../../dist/transport/transcription/wav.cjs');

function pcm(seconds, value = 8000) {
  const bytes = Buffer.alloc(seconds * 16000 * 2);
  for (let index = 0; index < bytes.length; index += 2) bytes.writeInt16LE(value, index);
  return bytes;
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('ASR task did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-asr-service-'));
  let service;
  let store = new Store(path.join(root, 'studio.sqlite'));
  const server = http.createServer(async (request, response) => {
    for await (const _part of request) {
      /* drain request */
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ text: '完整辨識結果' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = {
    ...store.settings().asr,
    provider: 'transcriptions',
    sampleRate: 16000,
    chunkSeconds: 2,
    fileUrl: `http://127.0.0.1:${port}/transcribe`,
    fileModel: 'test',
    fileApiKey: '',
  };
  const project = store.createProject('ASR 任務測試');
  const meeting = store.createMeeting(project.id, '持久化辨識');

  const makeService = () =>
    new AsrTaskService({
      store,
      directory: path.join(root, 'asr-spool'),

      settings: () => config,

      changed: () => {},
    });

  service = makeService();
  t.after(async () => {
    await service.close();
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    server,
    port,
    config,
    meeting,

    get store() {
      return store;
    },

    get service() {
      return service;
    },

    restart: async () => {
      await service.close();
      store.close();
      store = new Store(path.join(root, 'studio.sqlite'));
      store.recover();
      service = makeService();
      await service.start();
    },
  };
}

test('durable HTTP capture persists pause boundaries, hard limits and the final tail with exact offsets', async (t) => {
  const f = await fixture(t);
  f.config.chunkSeconds = 5;
  const live = f.service.createLive({
    meetingId: f.meeting.id,
    recordingId: 'dynamic-recording',
    offset: 12,
    config: f.config,

    emit: () => {},
  });
  await live.connect();
  const voice = pcm(1);
  const pause = pcm(0.9, 0);
  const first = Buffer.concat([voice, pause]);
  assert(live.audio(first));
  // A single packet spans the hard limit and a partial final segment.
  const rest = pcm(6);
  assert(live.audio(rest));
  assert.equal(live.position(), 19.9);
  await live.close();
  const job = f.service.repository.list().items[0];
  const chunks = f.service.repository.chunks(job.id);
  assert.deepEqual(
    chunks.map((chunk) => [chunk.start, chunk.end]),
    [
      [12, 13.9],
      [13.9, 18.9],
      [18.9, 19.9],
    ]
  );
  const audio = await Promise.all(
    chunks.map(async (chunk) => (await fs.readFile(chunk.path)).subarray(44))
  );
  assert.deepEqual(Buffer.concat(audio), Buffer.concat([first, rest]));
});

test('live HTTP recording keeps independently decodable queued audio while offline and recovers after service starts', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => f.server.close(resolve));
  await f.service.start();
  const events = [];
  const live = f.service.createLive({
    meetingId: f.meeting.id,
    recordingId: 'recording',
    offset: 12,
    config: f.config,

    emit: (event) => events.push(event),
  });
  await live.connect();
  assert(live.audio(pcm(3)));
  await live.close();
  await until(() => f.service.repository.list().items[0]?.state === 'waiting_retry');
  const job = f.service.repository.list().items[0];
  assert.equal(job.totalChunks, 2);
  assert.equal(job.failures, 0);
  assert.equal(job.error.kind, 'connection');
  assert.equal(
    f.service.repository.chunks(job.id).reduce((sum, chunk) => sum + chunk.end - chunk.start, 0),
    3
  );
  assert.equal(events.length, 0);
  await new Promise((resolve) => f.server.listen(f.port, '127.0.0.1', resolve));
  await f.service.act([job.id], 'retry');
  await until(() => f.service.repository.task(job.id).state === 'completed');
  const segments = f.store.get('meetings', f.meeting.id).segments;
  assert.deepEqual(
    segments.map((segment) => [segment.start, segment.end]),
    [
      [12, 14],
      [14, 15],
    ]
  );
  assert.equal(new Set(segments.map((segment) => segment.id)).size, 2);
});

test('managed original and partially prepared background job survive restart; explicit pause stays paused', async (t) => {
  const f = await fixture(t);
  const original = path.join(f.root, 'original.wav');
  await fs.writeFile(original, pcmWav(pcm(4), 16000));
  f.store.recording(f.meeting.id, {
    id: 'recording',
    path: original,
    complete: true,
    duration: 4,
    offset: 20,
    startedAt: new Date().toISOString(),
  });
  const job = f.service.createFile({
    meetingId: f.meeting.id,
    recordingId: 'recording',
    file: original,
    source: 'recording',
    denoise: false,
    start: 1,
    end: 3,
  });
  await until(() => f.service.repository.task(job.id).sealed);
  await f.service.act([job.id], 'pause');
  await f.restart();
  assert.equal(f.service.repository.task(job.id).state, 'paused');
  await f.service.act([job.id], 'resume');
  await until(() => f.service.repository.task(job.id).state === 'completed');
  const segment = f.store.get('meetings', f.meeting.id).segments[0];
  assert.equal(segment.start, 21);
  assert.equal(segment.end, 23);
  assert.equal((await fs.readFile(original)).subarray(0, 4).toString(), 'RIFF');
});

test('deleting active live task preserves exclusion and stopping auto recovery prevents its resurrection', async (t) => {
  const f = await fixture(t);
  const live = f.service.createLive({
    meetingId: f.meeting.id,
    recordingId: 'recording',
    offset: 0,
    config: f.config,

    emit: () => {},
  });
  await live.connect();
  live.audio(pcm(2));
  await until(() => f.service.repository.list().items[0]?.totalChunks === 1);
  const job = f.service.repository.list().items[0];
  await f.service.act([job.id], 'delete');
  f.service.repository.autoRecovery(f.meeting.id, false);
  live.audio(pcm(2));
  await live.close();
  assert.equal(f.service.repository.list().total, 0);
  assert.equal(f.service.repository.task(job.id).deleted, true);
  await f.restart();
  assert.equal(f.service.repository.autoRecovery(f.meeting.id), false);
  assert.equal(f.service.repository.list().total, 0);
  assert.equal(f.store.get('meetings', f.meeting.id).segments.length, 0);
});

test('spool capacity failure records the missing audio range and survives restart for manual recovery', async (t) => {
  const f = await fixture(t);
  f.service.spool.maxBytes = 1;
  const live = f.service.createLive({
    meetingId: f.meeting.id,
    recordingId: 'recording',
    offset: 10,
    config: f.config,

    emit: () => {},
  });
  await live.connect();
  live.audio(pcm(2));
  await live.close();
  const task = f.service.repository.list().items[0];
  assert.equal(task.state, 'needs_attention');
  assert.equal(task.totalChunks, 0);
  assert.equal(task.unpersistedRanges.length, 1);
  assert.deepEqual([task.unpersistedRanges[0].start, task.unpersistedRanges[0].end], [10, 12]);
  await f.restart();
  assert.equal(f.service.repository.task(task.id).state, 'needs_attention');
  assert.equal(f.service.repository.task(task.id).unpersistedRanges.length, 1);
});

test('deletion fences pending disk writes and buffered old audio; only newly captured audio may create a successor', async (t) => {
  const f = await fixture(t);
  f.service.repository.pauseBackground(true);
  const live = f.service.createLive({
    meetingId: f.meeting.id,
    recordingId: 'recording',
    offset: 0,
    config: f.config,

    emit: () => {},
  });
  await live.connect();
  const original = f.service.repository.list().items[0];
  live.audio(pcm(2));
  live.audio(pcm(0.5));
  await f.service.act([original.id], 'delete');
  live.audio(pcm(1));
  live.commit();
  await live.close();
  const page = f.service.repository.list();
  assert.equal(page.total, 1);
  const successor = page.items[0];
  const chunks = f.service.repository.chunks(successor.id);
  assert.notEqual(successor.id, original.id);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].start, 2.5);
  assert.equal(chunks[0].end, 3.5);
  assert.equal(f.store.get('meetings', f.meeting.id).segments.length, 0);
});

test('missing fallback configuration retains independently decodable recovery audio and requires settings', async (t) => {
  const f = await fixture(t);
  f.config.fileUrl = 'invalid-endpoint';
  await f.service.start();
  const live = f.service.createLive({
    meetingId: f.meeting.id,
    recordingId: 'recording',
    offset: 0,
    config: f.config,
    recovery: true,

    emit: () => {},
  });
  await live.connect();
  live.audio(pcm(1));
  live.commit();
  await live.close();
  await live.activate();
  await until(() => f.service.repository.list().items[0].state === 'needs_attention');
  const task = f.service.repository.list().items[0];
  assert.equal(task.error.kind, 'configuration');
  assert.equal(task.completedChunks, 0);
  const chunk = f.service.repository.chunks(task.id)[0];
  assert.equal((await f.service.spool.bytes(chunk)).subarray(0, 4).toString(), 'RIFF');
});

test('invalid credential headers never leak into persisted task errors', async (t) => {
  const f = await fixture(t);
  f.config.fileHeaders = { 'x-api-key': 'private-header-secret\ninvalid' };
  await f.service.start();
  const live = f.service.createLive({
    meetingId: f.meeting.id,
    recordingId: 'recording',
    offset: 0,
    config: f.config,
    recovery: true,

    emit: () => {},
  });
  await live.connect();
  live.audio(pcm(1));
  await live.close();
  await live.activate();
  await until(() => f.service.repository.list().items[0].state === 'needs_attention');
  const task = f.service.repository.list().items[0];
  assert.equal(task.error.kind, 'configuration');
  assert(!JSON.stringify(task).includes('private-header-secret'));
  const rows = f.service.repository.db.prepare('SELECT data FROM asr_tasks').all();
  assert(rows.every((row) => !row.data.includes('private-header-secret')));
});
