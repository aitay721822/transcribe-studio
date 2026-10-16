const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AsrRepository } = require('../../dist/persistence/asr/repository.cjs');
const { AudioSpool } = require('../../dist/services/asr/spool.cjs');
const { TranscriptionQueue } = require('../../dist/services/asr/queue.cjs');
const { transcriptionServiceId } = require('../../dist/services/asr/service.cjs');
const {
  failureInfo,
  httpFailure,
  retryAfter,
  retryDelay,
} = require('../../dist/domain/asr/retry.cjs');

const config = {
  fileUrl: 'http://127.0.0.1:1/transcribe',
  fileModel: 'test',
  fileApiKey: 'secret',
};

function task(repo, overrides = {}) {
  return repo.create({
    meetingId: 'meeting',
    projectId: 'project',
    recordingId: 'recording',
    title: '會議',
    source: 'recovery',
    serviceId: transcriptionServiceId(config),
    ...overrides,
  });
}

function append(repo, job, index = 0) {
  const chunk = {
    id: `${job.id}-${index}`,
    taskId: job.id,
    index,
    start: index * 5,
    end: index * 5 + 5,
    path: '/unused.wav',
    bytes: 100,
    checksum: 'test',
    state: 'queued',
    attempts: 0,
    failures: 0,
    generation: job.generation,
    lease: '',
  };
  assert(repo.append(chunk, job.generation));
  return chunk;
}

async function directory(t, beforeCleanup = () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-asr-queue-'));
  t.after(async () => {
    await beforeCleanup();
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail('queue did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('retry policy classifies transport/auth/timeout failures and honors numeric/date Retry-After', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  assert.equal(retryAfter('120', now), now + 120000);
  assert.equal(retryAfter('Fri, 16 Oct 2026 00:02:00 GMT', now), now + 120000);
  assert.equal(retryAfter('garbage', now), undefined);
  assert.equal(retryAfter('-1', now), undefined);
  assert.equal(retryAfter('999999999999999999999', now), undefined);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 99].map((n) => retryDelay(n, 0.5)),
    [2000, 5000, 10000, 20000, 40000, 60000, 60000]
  );
  assert.equal(retryDelay(1, 0), 1600);
  assert.equal(retryDelay(1, 1), 2400);
  assert.equal(
    failureInfo(new Error('private', { cause: { code: 'ECONNREFUSED' } })).scope,
    'service'
  );
  assert.equal(failureInfo(new DOMException('private', 'TimeoutError')).scope, 'chunk');
  assert.equal(failureInfo({ code: 'CERT_HAS_EXPIRED' }).scope, 'none');
  assert.equal(httpFailure(401).scope, 'none');
  assert.equal(httpFailure(429, now + 1000).retryAt, now + 1000);
  assert.equal(httpFailure(429, 0, 'insufficient_quota').scope, 'none');
  assert.equal(httpFailure(503).scope, 'service');
  assert.equal(httpFailure(408).scope, 'chunk');
  assert(!JSON.stringify(failureInfo(new Error('secret'))).includes('secret'));
});

test('persisted leases recover after restart; pause/delete reject late results and deleted tasks cannot resurrect', async (t) => {
  let db;
  const root = await directory(t, () => db?.close());
  db = new DatabaseSync(path.join(root, 'jobs.sqlite'));
  let repo = new AsrRepository(db);
  const job = task(repo);
  append(repo, job);
  repo.seal(job.id, job.generation);
  const original = repo.claim();
  assert(original);
  db.close();
  db = new DatabaseSync(path.join(root, 'jobs.sqlite'));
  repo = new AsrRepository(db);
  repo.recover();
  assert.equal(repo.task(job.id).state, 'queued');
  assert.equal(repo.valid(original), false);
  const resumed = repo.claim();
  assert.notEqual(resumed.chunk.lease, original.chunk.lease);
  repo.act([job.id], 'pause');
  let applied = 0;
  assert.equal(
    repo.complete(resumed, 'late', () => applied++),
    false
  );
  assert.equal(applied, 0);
  repo.recover();
  assert.equal(repo.task(job.id).state, 'paused');
  repo.act([job.id], 'retry');
  assert.equal(repo.task(job.id).state, 'paused');
  repo.act([job.id], 'resume');
  const next = repo.claim();
  repo.act([job.id], 'delete');
  assert.equal(
    repo.complete(next, 'late', () => applied++),
    false
  );
  assert.equal(repo.list().total, 0);
  assert.equal(repo.append({ ...next.chunk, id: 'new' }, next.task.generation), false);
  assert.throws(() => task(repo, { id: job.id }), /已存在/);
  repo.recover();
  assert.equal(repo.task(job.id).deleted, true);
});

test('one service shares cooldown, retries do not consume offline chunks, manual retry obeys server deadline', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 10000;
  const repo = new AsrRepository(db, () => now);
  const first = task(repo);
  const second = task(repo);
  append(repo, first);
  append(repo, second);
  const claim = repo.claim();
  assert.equal(repo.claim(), undefined);
  const deadline = now + 120000;
  repo.fail(claim, httpFailure(429, deadline), 0.5);
  assert.equal(repo.chunk(claim.chunk.id).failures, 0);
  assert.equal(repo.health(first.serviceId).nextAttemptAt, deadline);
  assert.equal(repo.claim(), undefined);
  repo.act([claim.task.id], 'retry');
  assert.equal(repo.claim(), undefined);
  assert.equal(repo.nextDueAt(), deadline);
  now = deadline;
  assert(repo.claim());
  assert.equal(repo.task(second.id).failures, 0);
});

test('six response failures need attention; shared configuration errors block further requests until explicit retry', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 1000;
  const repo = new AsrRepository(db, () => now);
  const job = task(repo);
  append(repo, job);
  for (let n = 0; n < 6; n++) {
    const claim = repo.claim();
    assert(claim);
    repo.fail(claim, httpFailure(408), 0.5);
    now = repo.task(job.id).nextAttemptAt;
  }
  assert.equal(repo.task(job.id).state, 'needs_attention');
  assert.equal(repo.claim(), undefined);
  repo.act([job.id], 'retry');
  const claim = repo.claim();
  repo.fail(claim, httpFailure(401), 0.5);
  const other = task(repo);
  append(repo, other);
  repo.act([other.id], 'pause');
  repo.act([other.id], 'resume');
  assert.equal(repo.task(other.id).state, 'needs_attention');
  assert.equal(repo.task(other.id).error.status, 401);
  assert.equal(repo.claim(), undefined);
  assert.equal(repo.nextDueAt(), undefined);
  repo.act([job.id], 'retry');
  assert(repo.claim());
});

test('result application and task completion commit atomically and survive rollback without duplication', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const repo = new AsrRepository(db);
  db.exec('CREATE TABLE transcript(id TEXT PRIMARY KEY, text TEXT)');
  const job = task(repo);
  append(repo, job);
  repo.seal(job.id, job.generation);
  const claim = repo.claim();
  assert.throws(() =>
    repo.complete(claim, 'text', (_, chunk, text) => {
      db.prepare('INSERT INTO transcript VALUES (?,?)').run(chunk.id, text);
      throw new Error('crash before completion');
    })
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcript').get().n, 0);
  assert(repo.valid(claim));
  assert(
    repo.complete(claim, 'text', (_, chunk, text) =>
      db.prepare('INSERT INTO transcript VALUES (?,?)').run(chunk.id, text)
    )
  );
  assert.equal(repo.task(job.id).state, 'completed');
  assert.equal(
    repo.complete(claim, 'text', () => assert.fail('must not apply twice')),
    false
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcript').get().n, 1);
});

test('scheduler query does not starve eligible jobs beyond a hundred blocked jobs; global pause preserves individual choices', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const repo = new AsrRepository(db, () => 1000);
  for (let index = 0; index < 120; index++) {
    const job = task(repo, { serviceId: `blocked-${index}` });
    append(repo, job);
    repo.saveHealth({ id: job.serviceId, failures: 1, nextAttemptAt: 100000, notBefore: 0 });
  }
  const eligible = task(repo);
  append(repo, eligible);
  assert.equal(repo.claim().task.id, eligible.id);
  repo.pauseBackground(true);
  assert.equal(repo.claim(), undefined);
  repo.act([eligible.id], 'pause');
  const later = task(repo, { serviceId: 'later' });
  append(repo, later);
  repo.pauseBackground(false);
  assert.equal(repo.task(eligible.id).state, 'paused');
  assert.equal(repo.claim().task.id, later.id);
});

test('spool validates bytes, boundaries and capacity; deleting owned temporary data preserves original recording', async (t) => {
  const root = await directory(t);
  const spool = new AudioSpool(path.join(root, 'spool'), 100, 0);
  const original = path.join(root, 'original.webm');
  await fs.writeFile(original, 'original');
  await assert.rejects(spool.capacity(80, 21), /空間不足/);
  const chunk = await spool.put('task', 0, 0, 5, Buffer.from('audio'), 0);
  assert.equal((await spool.bytes(chunk)).toString(), 'audio');
  const manifests = [];
  for await (const value of spool.manifests()) manifests.push(value);
  assert.equal(manifests.length, 1);
  await assert.rejects(spool.put('task', 0, 0, 5, Buffer.from('different'), 0), /不一致/);
  await assert.rejects(spool.put('../escape', 0, 0, 5, Buffer.from('audio'), 0), /路徑/);
  await spool.saveResult({ ...chunk, lease: 'lease' }, 'result');
  assert.equal((await spool.result(chunk)).text, 'result');
  await assert.rejects(spool.removeChunk({ ...chunk, path: original }), /允許範圍/);
  await fs.writeFile(chunk.path, 'broken');
  await assert.rejects(spool.bytes(chunk), /校驗/);
  await spool.removeTask('task');
  assert.equal(await fs.readFile(original, 'utf8'), 'original');
});

test('background worker reuses a crash-persisted response without a second remote request', async (t) => {
  let db;
  let queue;
  const root = await directory(t, async () => {
    await queue?.close();
    db?.close();
  });
  db = new DatabaseSync(path.join(root, 'jobs.sqlite'));
  const repo = new AsrRepository(db);
  const spool = new AudioSpool(path.join(root, 'spool'));
  const job = task(repo);
  const chunk = await spool.put(job.id, 0, 0, 5, Buffer.from('audio'), 0);
  repo.append(chunk, 0);
  repo.seal(job.id, 0);
  const previous = repo.claim();
  await spool.saveResult(previous.chunk, 'saved result');
  repo.recover();
  let applied = 0;
  queue = new TranscriptionQueue({
    repository: repo,
    spool,

    settings: () => ({ ...config, fileUrl: 'http://new-service.invalid/transcribe' }),

    changed: () => {},

    request: async () => assert.fail('must reuse saved response'),

    apply: (_, value, text) => {
      assert.equal(value.id, chunk.id);
      assert.equal(text, 'saved result');
      applied++;
    },
  });
  queue.start();
  await until(() => repo.task(job.id).state === 'completed');
  assert.equal(applied, 1);
  await queue.close();
});

test('pausing in-flight inference rejects a late successful response even if the transport ignores abort', async (t) => {
  let db;
  let queue;
  const root = await directory(t, async () => {
    await queue?.close();
    db?.close();
  });
  db = new DatabaseSync(':memory:');
  const repo = new AsrRepository(db);
  const spool = new AudioSpool(path.join(root, 'spool'));
  const job = task(repo);
  repo.append(await spool.put(job.id, 0, 0, 5, Buffer.from('audio'), 0), 0);
  repo.seal(job.id, 0);
  let resolveRequest;
  let started = false;
  let applied = 0;
  queue = new TranscriptionQueue({
    repository: repo,
    spool,

    settings: () => config,

    changed: () => {},

    apply: () => applied++,

    request: () =>
      new Promise((resolve) => {
        started = true;
        resolveRequest = resolve;
      }),
  });
  queue.start();
  await until(() => started);
  queue.act([job.id], 'pause');
  resolveRequest('late result');
  await queue.close();
  assert.equal(applied, 0);
  assert.equal(repo.task(job.id).state, 'paused');
  assert.equal(repo.task(job.id).completedChunks, 0);
});

test('pagination remains bounded across meetings and a long sleep causes one probe rather than a timer backlog', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = 1000;
  const repo = new AsrRepository(db, () => now);
  for (let index = 0; index < 125; index++) {
    const job = task(repo, {
      meetingId: `meeting-${index % 5}`,
      projectId: `project-${index % 2}`,
    });
    append(repo, job);
  }
  const page = repo.list({ meetingId: 'meeting-0', limit: 10 });
  assert.equal(page.total, 25);
  assert.equal(page.items.length, 10);
  assert.equal(page.nextOffset, 10);
  const next = repo.list({ meetingId: 'meeting-0', limit: 10, offset: 10 });
  assert(next.items.every((job) => !page.items.some((first) => first.id === job.id)));
  const first = repo.claim();
  repo.fail(first, httpFailure(503, now + 60000), 0.5);
  now += 24 * 60 * 60 * 1000;
  const probe = repo.claim();
  assert(probe);
  assert.equal(repo.claim(), undefined);
  repo.fail(probe, httpFailure(503), 0.5);
  assert.equal(repo.claim(), undefined);
  assert.equal(repo.task(probe.task.id).failures, 0);
  assert(repo.list().items.every((job) => job.failures === 0));
});
