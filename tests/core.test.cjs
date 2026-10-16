const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store, DEFAULTS } = require('../dist/persistence/store.cjs');
const { readFile, listFiles } = require('../dist/services/workspace/files.cjs');
const { discoverSkills } = require('../dist/harness/skills.cjs');
const { normalize } = require('../dist/transport/asr.cjs');
const { parseTranscript } = require('../dist/services/meetings/transcript.cjs');
const { exportDocx } = require('../dist/services/documents/export-docx.cjs');
const { removeProject } = require('../dist/services/projects/lifecycle.cjs');
const { ProjectEditSessions } = require('../dist/services/projects/edit-session.cjs');
const { removeMeeting } = require('../dist/services/meetings/lifecycle.cjs');
const { MeetingHistoryReader } = require('../dist/services/meetings/history.cjs');

test('history reads only earlier meetings in the same project, paginates notes and rechecks deletion', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('本專案');
    const previous = store.createMeeting(project.id, '先前決議');
    store.updateMeeting(previous.id, { notes: '需求規格與上線決議'.repeat(2000) }, 0);
    const current = store.createMeeting(project.id, '本次');
    const newer = store.createMeeting(project.id, '未來');
    const data = store.get('meetings', newer.id);
    data.createdAt = '2099-01-01T00:00:00.000Z';
    store.putMeeting(data);
    const other = store.createProject('其他');
    const outside = store.createMeeting(other.id, '其他的決議');
    const history = new MeetingHistoryReader(store, current);
    assert.equal(history.search().total, 1);
    assert.equal(history.search('先前 規格').meetings[0].meetingId, previous.id);
    assert.equal(history.read(previous.id, 100, 10).notes.length, 10);
    assert.equal(history.read(previous.id, 100, 10).nextOffset, 110);
    assert.match(history.read(previous.id).citation, /:v1\]/);
    assert.throws(() => history.read(current.id), /找不到/);
    assert.throws(() => history.read(newer.id), /找不到/);
    assert.throws(() => history.read(outside.id), /找不到/);
    store.deleteMeeting(previous.id);
    assert.equal(history.search().total, 0);
    assert.throws(() => history.read(previous.id), /找不到/);
  } finally {
    store.close();
  }
});

test('meeting deletion clears versions, JSONL and owned audio, retaining project, other meetings and shared audio', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-meeting-delete-'));
  await fs.mkdir(path.join(dir, 'audio'));
  const store = new Store(path.join(dir, 'studio.sqlite'));
  try {
    const p = store.createProject('保留專案');
    const m = store.createMeeting(p.id, '刪除');
    const other = store.createMeeting(p.id, '保留會議');
    const unique = path.join(dir, 'audio', 'unique.webm');
    const shared = path.join(dir, 'audio', 'shared.webm');
    await fs.writeFile(unique, 'remove');
    await fs.writeFile(shared, 'keep');
    store.recording(m.id, { id: 'unique', path: unique });
    store.recording(m.id, { id: 'shared', path: shared });
    store.recording(other.id, { id: 'shared-other', path: shared });
    store.updateMeeting(
      m.id,
      { notes: '第一版', chats: [{ text: '對話', createdAt: new Date().toISOString() }] },
      0
    );
    store.updateMeeting(m.id, { notes: '第二版' }, 1);
    const journal = store.conversations.filename(m.id);
    await fs.access(journal);
    const result = await removeMeeting(store, dir, m.id);
    assert.deepEqual(result.warnings, []);
    assert.equal(store.get('meetings', m.id), null);
    assert.equal(store.revisionList(m.id).length, 0);
    await assert.rejects(fs.access(journal));
    await assert.rejects(fs.access(unique));
    assert.equal(await fs.readFile(shared, 'utf8'), 'keep');
    assert(store.get('projects', p.id));
    assert(store.get('meetings', other.id));
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('meeting deletion rejects external paths and rechecks running work before committing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-meeting-guard-'));
  const store = new Store(path.join(dir, 'studio.sqlite'));
  try {
    const p = store.createProject('專案');
    const m = store.createMeeting(p.id, '外部錄音');
    const file = path.join(dir, 'external.txt');
    await fs.writeFile(file, 'keep');
    store.recording(m.id, { id: 'outside', path: file });
    await assert.rejects(removeMeeting(store, dir, m.id), /超出/);
    assert(store.get('meetings', m.id));
    assert.equal(await fs.readFile(file, 'utf8'), 'keep');
    const busy = store.createMeeting(p.id, '工作啟動競爭');
    let checks = 0;
    await assert.rejects(
      removeMeeting(store, dir, busy.id, () => {
        if (++checks === 2) throw new Error('工作中');
      }),
      /工作中/
    );
    assert.equal(checks, 2);
    assert(store.get('meetings', busy.id));
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('project editor stages authorized folders, cancels drafts and rejects stale or foreign roots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-edit-'));
  const store = new Store(':memory:');
  try {
    const project = store.createProject('原專案');
    const edits = new ProjectEditSessions();
    const token = edits.begin(project);
    const picked = await edits.add(token, [dir, dir]);
    assert.equal(picked.length, 1);
    assert.deepEqual(store.get('projects', project.id).roots, []);
    assert.throws(() => edits.prepare(token, project, '改名', ['unpicked']), /未經選取/);
    assert.throws(() => edits.prepare(token, project, ' ', []), /專案名稱/);
    assert.throws(
      () => edits.prepare(token, project, '改名', [picked[0].id, picked[0].id]),
      /清單無效/
    );
    edits.end(token);
    assert.throws(() => edits.prepare(token, project, '改名', []), /編輯已結束/);
    assert.equal(store.get('projects', project.id).name, '原專案');
    const savedToken = edits.begin(project);
    const roots = await edits.add(savedToken, [dir]);
    const patch = edits.prepare(savedToken, project, ' 新名稱 ', [roots[0].id]);
    const saved = store.updateProject(project.id, patch);
    assert.equal(saved.name, '新名稱');
    assert.equal(saved.roots[0].path, await fs.realpath(dir));
    assert.throws(() => edits.prepare(savedToken, saved, '覆蓋', []), /已變更/);
    const removeToken = edits.begin(saved);
    store.updateProject(saved.id, edits.prepare(removeToken, saved, saved.name, []));
    assert.deepEqual(store.get('projects', saved.id).roots, []);
    assert((await fs.stat(dir)).isDirectory());
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('project edit, archive and restore persist; archived projects cannot create new meetings', async () => {
  const store = new Store(':memory:');
  const p = store.createProject('原名稱');
  assert.throws(() => store.updateProject(p.id, { name: '  ' }), /專案名稱/);
  assert.equal(store.updateProject(p.id, { name: '修訂名稱' }).name, '修訂名稱');
  store.updateProject(p.id, { archivedAt: new Date().toISOString() });
  assert.throws(() => store.createMeeting(p.id, 'new'), /解除封存/);
  store.updateProject(p.id, { archivedAt: null });
  assert(store.createMeeting(p.id, 'restored'));
  store.close();
});
test('project deletion removes app records, audio and JSONL while preserving referenced workspace', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-project-'));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-reference-'));
  await fs.writeFile(path.join(external, 'keep.txt'), '保留工作區');
  await fs.mkdir(path.join(dir, 'audio'));
  const store = new Store(path.join(dir, 'studio.sqlite'));
  const p = store.createProject('delete');
  store.updateProject(p.id, {
    roots: [{ id: 'r', path: external, name: 'reference', mode: 'readonly' }],
  });
  const m = store.createMeeting(p.id, 'meeting');
  store.updateMeeting(m.id, { notes: 'notes', chats: [{ text: 'request', createdAt: 'now' }] }, 0);
  const file = path.join(dir, 'audio', 'test.webm');
  await fs.writeFile(file, 'recording');
  store.recording(m.id, { id: 'audio1', path: file, complete: true });
  const kept = store.createProject('kept');
  const runtime = path.join(dir, 'runtime', 'projects', p.id);
  const keptRuntime = path.join(dir, 'runtime', 'projects', kept.id);
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(keptRuntime, { recursive: true });
  await fs.writeFile(path.join(runtime, 'session.jsonl'), 'remove');
  await fs.writeFile(path.join(keptRuntime, 'session.jsonl'), 'keep');
  store.createMeeting(kept.id, 'kept');
  assert.deepEqual((await removeProject(store, dir, p.id)).warnings, []);
  assert.equal(store.get('projects', p.id), null);
  assert.equal(store.get('meetings', m.id), null);
  assert.equal(store.revisionList(m.id).length, 0);
  await assert.rejects(fs.access(file));
  await assert.rejects(fs.access(runtime));
  assert.equal(await fs.readFile(path.join(keptRuntime, 'session.jsonl'), 'utf8'), 'keep');
  await assert.rejects(fs.access(store.conversations.filename(m.id)));
  assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), '保留工作區');
  assert(store.get('projects', kept.id));
  store.close();
});
test('project deletion rejects a recording path outside the owned audio directory before modifying data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-project-guard-'));
  const store = new Store(path.join(dir, 'studio.sqlite'));
  const p = store.createProject('guard');
  const m = store.createMeeting(p.id, 'guard');
  const external = path.join(dir, 'external.txt');
  await fs.writeFile(external, 'keep');
  store.recording(m.id, { id: 'bad', path: external });
  await assert.rejects(removeProject(store, dir, p.id), /超出/);
  assert(store.get('projects', p.id));
  assert.equal(await fs.readFile(external, 'utf8'), 'keep');
  store.close();
});

test('SQLite persistence, final transcript deduplication, version conflict and crash recovery', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-store-'));
  const file = path.join(temp, 'test.sqlite');
  const s = new Store(file);
  const p = s.createProject('測試專案');
  const m = s.createMeeting(p.id, '會議');
  s.segment(m.id, { id: 'a', text: '暫定', final: false });
  s.segment(m.id, { id: 'a', text: '完成', final: true });
  s.segment(m.id, { id: 'a', text: '過期事件', final: false });
  assert.equal(s.get('meetings', m.id).segments.length, 1);
  assert.equal(s.get('meetings', m.id).segments[0].text, '完成');
  s.updateMeeting(m.id, { notes: '原稿' }, 0);
  s.updateMeeting(m.id, { notes: '新稿' }, 1);
  assert.throws(() => s.updateMeeting(m.id, { notes: '覆蓋' }, 1), /新版本/);
  assert.equal(s.revisionList(m.id)[0].notes, '原稿');
  s.updateMeeting(m.id, { status: 'recording' });
  s.close();
  const reopened = new Store(file);
  reopened.recover();
  assert.equal(reopened.get('meetings', m.id).status, 'interrupted');
  reopened.close();
});
test('multi-root workspace rejects traversal and secrets, loads DOCX and local skills', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-roots-'));
  const a = path.join(temp, 'a'),
    b = path.join(temp, 'b');
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'context.md'), '專案背景');
  await fs.writeFile(path.join(b, 'other.txt'), '跨資料夾資料');
  await fs.writeFile(path.join(a, '.env.local'), 'SECRET');
  const roots = [
    { id: 'a', path: a, name: 'A' },
    { id: 'b', path: b, name: 'B' },
  ];
  assert.equal(await readFile(roots, 'b', 'other.txt'), '跨資料夾資料');
  await assert.rejects(readFile(roots, 'a', '../b/other.txt'), /超出/);
  await assert.rejects(readFile(roots, 'a', '.env.local'), /排除/);
  await fs.mkdir(path.join(a, '.agents/skills/note'), { recursive: true });
  await fs.writeFile(
    path.join(a, '.agents/skills/note/SKILL.md'),
    '---\nname: notes\ndescription: Test\n---\nWrite notes'
  );
  assert.equal((await discoverSkills(roots, path.join(temp, 'absent')))[0].name, 'notes');
  const listed = await listFiles(roots);
  assert(listed.files.some((f) => f.rootId === 'b'));
  assert(!listed.files.some((f) => f.relative.includes('.env')));
  const doc = await exportDocx({
    title: '會議',
    createdAt: new Date().toISOString(),
    notes: '# 摘要\n內容\n\n| 項目 | 負責人 |\n| --- | --- |\n| 上線 | 待確認 |',
    segments: [],
  });
  await fs.writeFile(path.join(a, 'meeting.docx'), doc);
  assert.match(await readFile(roots, 'a', 'meeting.docx'), /待確認/);
  assert.equal(doc.subarray(0, 2).toString(), 'PK');
});
test('ASR adapter handles partial deltas, finals and nested custom events', () => {
  assert.equal(
    normalize(
      { results: [{ text: '陣列內容', final: true }] },
      { provider: 'websocket', mapping: { text: 'results.0.text', final: 'results.0.final' } },
      0,
      new Map()
    ).text,
    '陣列內容'
  );
  const cache = new Map();
  const config = { provider: 'openai' };
  normalize(
    { type: 'conversation.item.input_audio_transcription.delta', item_id: 's', delta: '會議' },
    config,
    1,
    cache
  );
  assert.equal(
    normalize(
      { type: 'conversation.item.input_audio_transcription.delta', item_id: 's', delta: '開始' },
      config,
      2,
      cache
    ).text,
    '會議開始'
  );
  const final = normalize(
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 's',
      transcript: '會議正式開始',
    },
    config,
    3,
    cache
  );
  assert.equal(final.start, 1);
  assert.equal(final.final, true);
  assert.equal(final.text, '會議正式開始');
  const c = {
    provider: 'websocket',
    mapping: {
      text: 'result.text',
      id: 'result.id',
      final: 'result.final',
      start: 'result.start',
      end: 'result.end',
    },
  };
  assert.equal(
    normalize(
      { result: { text: '內容', id: '2', final: true, start: 0, end: 5 } },
      c,
      10,
      new Map()
    ).start,
    0
  );
});
test('SRT and VTT preserve segment timestamps', () => {
  const segments = parseTranscript(
    '1\n00:00:01,000 --> 00:00:03,500\n第一段\n\n2\n00:00:04,000 --> 00:00:06,000\n第二段'
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].end, 3.5);
  assert.equal(parseTranscript('WEBVTT\n\n00:01.000 --> 00:02.000\n字幕')[0].start, 1);
});
