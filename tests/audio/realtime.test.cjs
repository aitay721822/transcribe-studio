const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { Store } = require('../../dist/persistence/store.cjs');
const { AsrTaskService } = require('../../dist/services/asr/tasks.cjs');
const { RecoveringRealtimeSession } = require('../../dist/services/asr/realtime/session.cjs');
const { RealtimeCoverage } = require('../../dist/transport/realtime/coverage.cjs');

function pcm(seconds, value = 8000, rate = 16000) {
  const bytes = Buffer.alloc(seconds * rate * 2);
  for (let index = 0; index < bytes.length; index += 2) bytes.writeInt16LE(value, index);
  return bytes;
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Realtime recovery did not reach expected state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-realtime-recovery-'));
  const store = new Store(path.join(directory, 'studio.sqlite'));
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    requests++;
    for await (const _chunk of request) {
      /* drain */
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ text: '離線期間的音訊' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    ...store.settings().asr,
    provider: 'websocket',
    sampleRate: 16000,
    url: 'ws://127.0.0.1:1',
    fileUrl: `http://127.0.0.1:${server.address().port}/transcribe`,
    fileModel: 'test',
    fileApiKey: '',
    ...overrides.config,
  };
  const project = store.createProject('Realtime');
  const meeting = store.createMeeting(project.id, '重連測試');
  const tasks = new AsrTaskService({
    store,
    directory: path.join(directory, 'spool'),

    settings: () => config,

    changed: () => {},
  });
  const callbacks = [];
  const states = [];
  const rtcEpochs = [];
  let healthy = overrides.healthy !== false;
  let session;
  const options = {
    meetingId: meeting.id,
    recordingId: 'recording',
    offset: 0,
    repository: tasks.repository,
    spool: tasks.spool,

    settings: () => config,

    capture: (offset) =>
      tasks.createLive({
        meetingId: meeting.id,
        recordingId: 'recording',
        offset,
        config,
        recovery: true,

        emit: () => {},
      }),

    emit: (event) => {
      if (event.segment) store.segment(meeting.id, event.segment);
    },

    status: (status) => states.push(status),

    rtc: (epoch) => rtcEpochs.push(epoch),

    factory: (_config, emit) => {
      callbacks.push(emit);
      return {
        connect: async () => {
          if (!healthy) throw new Error('offline', { cause: { code: 'ECONNREFUSED' } });
        },

        audio: () => true,

        commit: () => {},

        close: async () => {},
      };
    },

    ...overrides.options,
  };
  session = new RecoveringRealtimeSession(options);
  t.after(async () => {
    await session.close();
    await tasks.close();
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await tasks.start();
  await session.connect();
  return {
    session,
    tasks,
    store,
    meeting,
    config,
    callbacks,
    states,
    rtcEpochs,
    options,

    get requests() {
      return requests;
    },

    healthy: () => {
      healthy = true;
    },
  };
}

test('commit coverage correlates item ids and accepts out-of-order completions without acknowledging unrelated audio', () => {
  const coverage = new RealtimeCoverage();
  coverage.audio(32000, 16000);
  coverage.commit();
  coverage.audio(64000, 16000);
  coverage.commit();
  coverage.receive({ type: 'input_audio_buffer.committed', item_id: 'first' });
  coverage.receive({ type: 'input_audio_buffer.committed', item_id: 'second' });
  assert.deepEqual(coverage.finish('second'), { start: 1, end: 3 });
  assert.equal(coverage.finish('unknown'), undefined);
  assert.deepEqual(coverage.finish('first'), { start: 0, end: 1 });
  assert.equal(coverage.finish('first'), undefined);
});

test('real OpenAI websocket commits correlate out-of-order finals and acknowledged audio never enters HTTP fallback', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  let count = 0;
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'session.update' || data.type === 'transcription_session.update') {
        ws.send(JSON.stringify({ type: 'transcription_session.updated' }));
      }
      if (data.type !== 'input_audio_buffer.commit') return;
      count++;
      ws.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `item-${count}` }));
      if (count !== 2) return;
      for (const id of [2, 1])
        ws.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: `item-${id}`,
            transcript: `即時第${id}段`,
          })
        );
    });
  });
  const f = await fixture(t, {
    config: {
      provider: 'openai',
      realtimeFlavor: 'openai',
      url: `ws://127.0.0.1:${server.address().port}`,
      model: 'test',
      sampleRate: 24000,
    },
    options: { factory: undefined },
  });
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await until(() => f.session.status().state === 'connected');
  f.session.audio(pcm(1, 8000, 24000));
  f.session.commit();
  f.session.audio(pcm(1, 8000, 24000));
  f.session.commit();
  await until(() => f.store.get('meetings', f.meeting.id).segments.length === 2);
  await f.session.close();
  const segments = f.store.get('meetings', f.meeting.id).segments;
  assert.deepEqual(
    segments.map((segment) => [segment.start, segment.end, segment.text]),
    [
      [0, 1, '即時第1段'],
      [1, 2, '即時第2段'],
    ]
  );
  assert.equal(f.requests, 0);
  assert(f.tasks.repository.list().items.every((task) => task.state === 'completed'));
});

test('websocket handshake 429 preserves Retry-After across retry actions; 401 requires intervention', async (t) => {
  let status = 429;
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(status, { 'Retry-After': '60' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const f = await fixture(t, {
    config: { url: `ws://127.0.0.1:${server.address().port}` },
    options: { factory: undefined },
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await until(() => f.session.status().state === 'waiting_retry');
  const deadline = f.session.status().nextAttemptAt;
  assert(deadline - Date.now() > 55000);
  f.session.action('retry');
  assert.equal(f.session.status().nextAttemptAt, deadline);
  assert.equal(requests, 1);
  const health = f.tasks.repository.db
    .prepare('SELECT id FROM asr_services WHERE id LIKE ?')
    .get('realtime:%');
  f.tasks.repository.saveHealth({ id: health.id, failures: 0, nextAttemptAt: 0, notBefore: 0 });
  status = 401;
  f.session.action('retry');
  await until(() => f.session.status().state === 'needs_attention');
  assert.equal(f.session.status().error.status, 401);
  assert.equal(requests, 2);
});

test('offline realtime keeps audio, a fresh connection handles new audio, and old epoch events cannot mutate transcript', async (t) => {
  const f = await fixture(t, { healthy: false });
  await until(() => f.session.status().state === 'waiting_retry');
  f.session.audio(pcm(2));
  f.session.commit();
  await until(
    () => f.requests === 1 && f.store.get('meetings', f.meeting.id).segments.length === 1
  );
  f.healthy();
  f.session.action('retry');
  await until(() => f.session.status().state === 'connected');
  assert.equal(f.callbacks.length, 2);
  f.session.audio(pcm(2));
  f.session.commit();
  f.callbacks[1]({
    type: 'segment',
    segment: {
      id: 'fresh',
      start: 0,
      end: 2,
      text: '恢復後即時文字',
      final: true,
      timing: 'provider',
      speaker: '',
    },
  });
  f.callbacks[0]({
    type: 'segment',
    segment: {
      id: 'stale',
      start: 0,
      end: 2,
      text: '不應寫入',
      final: true,
      timing: 'provider',
      speaker: '',
    },
  });
  await f.session.close();
  await until(() => f.tasks.repository.list().items.every((job) => job.state === 'completed'));
  const segments = f.store.get('meetings', f.meeting.id).segments;
  assert.equal(segments.length, 2);
  assert.equal(segments[1].start, 2);
  assert.equal(segments[1].end, 4);
  assert(!segments.some((segment) => segment.text === '不應寫入'));
  assert.equal(f.requests, 1, 'acknowledged new audio is not sent to offline ASR again');
});

test('silence never triggers response timeout; voiced audio without progress does and manual pause is respected', async (t) => {
  let now = 1000;
  const f = await fixture(t, {
    options: {
      now: () => now,

      random: () => 0.5,
    },
  });
  await until(() => f.session.status().state === 'connected');
  f.session.audio(pcm(1, 0));
  now += 90000;
  f.session.check();
  assert.equal(f.session.status().state, 'connected');
  f.session.audio(pcm(1));
  now += 30001;
  f.session.check();
  assert.equal(f.session.status().state, 'waiting_retry');
  assert.equal(f.session.status().error.kind, 'timeout');
  f.session.action('pause');
  f.session.action('retry');
  assert.equal(f.session.status().state, 'paused');
  assert.equal(f.tasks.repository.control('realtime-paused:recording'), true);
  f.session.action('resume');
  await until(() => f.session.status().state === 'connected');
});

test('WebRTC reattempt uses a new epoch, rejects old peer results, and keeps Retry-After on manual retry', async (t) => {
  const f = await fixture(t, {
    config: { provider: 'webrtc', signalingUrl: 'http://127.0.0.1:1/signal' },
  });
  await until(() => f.rtcEpochs.length === 1);
  const first = f.rtcEpochs[0];
  const notBefore = Date.now() + 300;
  f.session.rtcState(first, false, {
    kind: 'server',
    scope: 'service',
    status: 503,
    retryAt: notBefore,
    message: '稍後重試',
  });
  f.session.action('retry');
  assert.equal(f.rtcEpochs.length, 1);
  await until(() => f.rtcEpochs.length === 2);
  assert(Date.now() >= notBefore);
  const second = f.rtcEpochs[1];
  assert.notEqual(second, first);
  f.session.rtcState(first, true);
  assert.equal(f.session.status().state, 'connecting');
  f.session.rtcState(second, true);
  await until(() => f.session.status().state === 'connected');
  f.session.receive(
    { type: 'segment', segment: { id: 'stale', text: 'old peer', start: 0, end: 1, final: true } },
    first
  );
  assert.equal(f.store.get('meetings', f.meeting.id).segments.length, 0);
});

test('uncertain provider timing retains backup for human review instead of duplicating final realtime text', async (t) => {
  const f = await fixture(t);
  await until(() => f.session.status().state === 'connected');
  f.session.audio(pcm(2));
  f.session.commit();
  f.callbacks[0]({
    type: 'segment',
    segment: {
      id: 'approximate',
      text: '時間不確定的即時文字',
      start: 0,
      end: 2,
      final: true,
      timing: 'received',
    },
  });
  await f.session.close();
  assert(
    f.tasks.repository
      .list()
      .items.some((task) => task.state === 'needs_attention' && task.reviewRequired)
  );
  assert.equal(f.requests, 0);
  assert.equal(f.store.get('meetings', f.meeting.id).segments.length, 1);
});

test('partially acknowledged backup audio requires range review instead of duplicating confirmed words', async (t) => {
  const f = await fixture(t);
  await until(() => f.session.status().state === 'connected');
  f.session.audio(pcm(2));
  f.session.commit();
  f.callbacks[0]({
    type: 'segment',
    segment: {
      id: 'partial-range',
      start: 0,
      end: 1,
      text: '已確認的前半段',
      final: true,
      timing: 'provider',
    },
  });
  await f.session.close();
  await until(() =>
    f.tasks.repository
      .list()
      .items.some((task) => task.state === 'needs_attention' && task.reviewRequired)
  );
  assert.equal(f.requests, 0);
  assert.equal(f.store.get('meetings', f.meeting.id).segments.length, 1);
});

test('manual commit watchdog ignores unsubmitted audio and an out-of-order final cannot hide a stalled earlier turn', async (t) => {
  let now = 1000;
  const f = await fixture(t, {
    config: { provider: 'openai', realtimeFlavor: 'openai', model: 'test' },
    options: { now: () => now },
  });
  await until(() => f.session.status().state === 'connected');
  f.session.audio(pcm(1));
  now += 90000;
  f.session.check();
  assert.equal(f.session.status().state, 'connected');
  f.callbacks[0]({ type: 'audio-committed', coverage: { start: 0, end: 1 } });
  f.session.audio(pcm(1));
  f.callbacks[0]({ type: 'audio-committed', coverage: { start: 1, end: 2 } });
  f.callbacks[0]({
    type: 'segment',
    coverage: { start: 1, end: 2 },
    segment: {
      id: 'second-first',
      start: 1,
      end: 2,
      text: '較晚回合先完成',
      final: true,
    },
  });
  now += 30001;
  f.session.check();
  assert.equal(f.session.status().state, 'waiting_retry');
  assert.equal(f.session.status().error.kind, 'timeout');
});

test('concurrent recordings share one connection probe and a permanent failure prevents a second probe', async (t) => {
  let rejectFirst;
  let attempts = 0;
  const f = await fixture(t, {
    options: {
      factory: () => ({
        connect: () => {
          attempts++;
          return new Promise((_resolve, reject) => {
            rejectFirst = reject;
          });
        },

        audio: () => true,

        commit: () => {},

        close: async () => {},
      }),
    },
  });
  await until(() => attempts === 1);
  const second = new RecoveringRealtimeSession({ ...f.options, recordingId: 'second' });
  await second.connect();
  t.after(() => second.close());
  await until(() => second.status().state === 'waiting_retry');
  assert.equal(attempts, 1);
  rejectFirst(new Error('invalid certificate', { cause: { code: 'CERT_HAS_EXPIRED' } }));
  await until(() => second.status().state === 'needs_attention');
  assert.equal(attempts, 1);
  await second.close();
});
