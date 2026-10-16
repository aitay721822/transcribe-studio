const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../dist/persistence/store.cjs');
const { AudioSpool } = require('../../dist/services/asr/spool.cjs');
const { AsrTaskService } = require('../../dist/services/asr/tasks.cjs');
const { applyTaskResult } = require('../../dist/services/asr/results.cjs');
const { replacementRange } = require('../../dist/domain/asr/range.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-range-'));
  const store = new Store(path.join(root, 'studio.sqlite'));
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = store.createProject('範圍替換');
  const meeting = store.createMeeting(project.id, '原文保護');
  meeting.notes = '筆記必須保留';
  meeting.segments = [
    { id: 'old', recordingId: 'recording', start: 0, end: 10, text: '原始逐字稿', final: true },
    {
      id: 'outside',
      recordingId: 'recording',
      start: 10,
      end: 15,
      text: '範圍外文字',
      final: true,
    },
  ];
  store.putMeeting(meeting);
  return { root, store, meeting, repo: store.transcriptions };
}

function replacement(f) {
  const task = f.repo.create({
    meetingId: f.meeting.id,
    projectId: f.meeting.projectId,
    recordingId: 'recording',
    title: '替換',
    source: 'recording',
    serviceId: 'test',
    start: 0,
    end: 10,
    replace: true,
  });
  for (let index = 0; index < 2; index++)
    f.repo.append(
      {
        id: `${task.id}-${index}`,
        taskId: task.id,
        index,
        start: index * 5,
        end: index * 5 + 5,
        path: '/unused',
        bytes: 100,
        checksum: 'test',
        state: 'queued',
        attempts: 0,
        failures: 0,
        generation: task.generation,
        lease: '',
      },
      task.generation
    );
  f.repo.seal(task.id, task.generation);
  return task;
}

test('range selection expands transitively to complete overlapping paragraphs and preserves other recordings', () => {
  const segments = [
    { recordingId: 'a', start: 20, end: 24 },
    { recordingId: 'a', start: 23, end: 28 },
    { recordingId: 'b', start: 0, end: 100 },
    { recordingId: 'a', start: 28, end: 30 },
  ];
  const range = replacementRange(segments, 'a', 20, 1, 2);
  assert.equal(range.start, 0);
  assert.equal(range.end, 8);
  assert.equal(range.segments.length, 2);
});

test('partial replacement is staged; cancellation fences late completion and preserves original transcript and notes', async (t) => {
  const f = await fixture(t);
  const task = replacement(f);

  const apply = (job, chunk, text) => applyTaskResult(f.store, f.repo, job, chunk, text);

  assert(f.repo.complete(f.repo.claim(), '新文字第一段', apply));
  assert.equal(f.store.get('meetings', f.meeting.id).segments[0].text, '原始逐字稿');
  const late = f.repo.claim();
  f.repo.act([task.id], 'cancel');
  assert.equal(f.repo.complete(late, '不應套用', apply), false);
  const meeting = f.store.get('meetings', f.meeting.id);
  assert.equal(meeting.segments.length, 2);
  assert.equal(meeting.segments[0].text, '原始逐字稿');
  assert.equal(meeting.notes, '筆記必須保留');
});

test('all replacement chunks commit together; rollback can retry once without duplicated or missing text', async (t) => {
  const f = await fixture(t);
  const task = replacement(f);

  const apply = (job, chunk, text) => applyTaskResult(f.store, f.repo, job, chunk, text);

  f.repo.complete(f.repo.claim(), '新文字第一段', apply);
  const last = f.repo.claim();
  assert.throws(() =>
    f.repo.complete(last, '新文字第二段', (job, chunk, text) => {
      apply(job, chunk, text);
      throw new Error('simulated commit interruption');
    })
  );
  assert.equal(f.store.get('meetings', f.meeting.id).segments[0].text, '原始逐字稿');
  assert(f.repo.complete(last, '新文字第二段', apply));
  assert.equal(f.repo.complete(last, 'duplicate', apply), false);
  const meeting = f.store.get('meetings', f.meeting.id);
  assert.deepEqual(
    meeting.segments.map((segment) => segment.text),
    ['新文字第一段', '新文字第二段', '範圍外文字']
  );
  assert.equal(meeting.notes, '筆記必須保留');
  assert.equal(f.repo.task(task.id).state, 'completed');
});

test('startup isolates corrupted manifests, repairs committed manifests and cleans uncommitted files without removing originals', async (t) => {
  const f = await fixture(t);
  const spool = new AudioSpool(path.join(f.root, 'spool'), 100000, 0);

  const make = () =>
    f.repo.create({
      meetingId: f.meeting.id,
      projectId: f.meeting.projectId,
      recordingId: 'recording',
      title: '啟動修復',
      source: 'recovery',
      serviceId: 'test',
    });

  const healthy = make();
  const damaged = make();
  const chunk = await spool.put(healthy.id, 0, 0, 1, Buffer.alloc(100), 0);
  const corrupt = await spool.put(damaged.id, 0, 0, 1, Buffer.alloc(100), 0);
  await fs.writeFile(`${corrupt.path}.json`, '{broken');
  const orphan = path.join(path.dirname(chunk.path), 'uncommitted.wav');
  const temporary = `${chunk.path}.test.tmp`;
  const original = path.join(f.root, 'original.webm');
  const completed = make();
  const finishedChunk = await spool.put(completed.id, 0, 0, 1, Buffer.alloc(100), 0);
  f.repo.append(finishedChunk, 0);
  f.repo.seal(completed.id, 0);
  assert(f.repo.complete(f.repo.claim(), '完成後尚未清理', () => {}));
  const cancelled = make();
  await spool.put(cancelled.id, 0, 0, 1, Buffer.alloc(100), 0);
  f.repo.act([cancelled.id], 'cancel');
  const orphanResult = `${orphan}.result.json`;
  await Promise.all([
    fs.writeFile(orphan, 'incomplete'),
    fs.writeFile(temporary, 'incomplete'),
    fs.writeFile(original, 'original'),
    fs.writeFile(orphanResult, 'uncommitted result'),
  ]);
  f.repo.pauseBackground(true);
  const service = new AsrTaskService({
    store: f.store,
    directory: spool.root,

    settings: () => f.store.settings().asr,

    changed: () => {},
  });
  try {
    await service.start();
    assert.equal(f.repo.chunk(chunk.id).state, 'queued');
    assert.equal(f.repo.task(damaged.id).state, 'needs_attention');
    assert.equal(f.repo.task(damaged.id).reviewRequired, true);
    await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
    await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
    await assert.rejects(fs.stat(orphanResult), { code: 'ENOENT' });
    await assert.rejects(fs.stat(finishedChunk.path), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(spool.root, cancelled.id)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(original, 'utf8'), 'original');
  } finally {
    await service.close();
  }
});
