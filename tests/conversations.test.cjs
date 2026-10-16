const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../dist/persistence/store.cjs');
const { ConversationRepository } = require('../dist/persistence/conversations.cjs');

test('JSONL persists conversation, tool results and provider sessions independently of SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-journal-'));
  const file = path.join(dir, 'studio.sqlite');
  const store = new Store(file);
  const p = store.createProject('Project');
  const m = store.createMeeting(p.id, 'Meeting');
  const chats = [{ text: '整理決議', createdAt: new Date().toISOString() }];
  store.updateMeeting(m.id, {
    chats,
    agentSessions: { claude: { id: 'session1', fingerprint: 'fp' } },
  });
  const run = {
    id: 'run1',
    meetingId: m.id,
    version: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    events: [{ type: 'tool-result', name: 'studio_read_notes', result: { notes: '原稿' } }],
  };
  store.saveRun(run);
  store.saveRun(run);
  const raw = JSON.parse(store.db.prepare('SELECT data FROM meetings WHERE id=?').get(m.id).data);
  assert.equal(raw.chats, undefined);
  assert.equal(raw.agentSessions, undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  store.close();
  const reopened = new Store(file);
  reopened.recover();
  assert.deepEqual(reopened.get('meetings', m.id).chats, chats);
  assert.equal(reopened.get('meetings', m.id).agentSessions.claude.id, 'session1');
  assert.equal(reopened.get('runs', 'run1').status, 'cancelled');
  assert.equal(
    reopened.get('runs', 'run1').events.filter((e) => e.type === 'tool-result').length,
    1
  );
  assert.throws(() => reopened.updateMeeting(m.id, { chats: [] }), /只能追加/);
  const journal = fs
    .readFileSync(path.join(dir, 'conversations', `${m.id}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert(journal.some((r) => r.type === 'run-event' && r.data.event.result?.notes === '原稿'));
  reopened.close();
});
test('JSONL repairs torn UTF-8 tail but rejects interior corruption and path traversal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tail-'));
  const repo = new ConversationRepository(dir);
  repo.append('meeting1', 'message', { text: '繁體中文', createdAt: 'now' });
  fs.appendFileSync(repo.filename('meeting1'), '{"schemaVersion":1,"data":"unfinished');
  assert.equal(repo.messages('meeting1')[0].text, '繁體中文');
  repo.append('meeting1', 'message', { text: '恢復後', createdAt: 'later' });
  assert.equal(repo.read('meeting1').length, 2);
  fs.appendFileSync(repo.filename('meeting1'), 'broken\n');
  assert.throws(() => repo.read('meeting1'), /損毀/);
  assert.throws(() => repo.read('../escape'), /無效/);
});
test('legacy SQLite chats and runs migrate once without duplicated messages or events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-migration-'));
  const file = path.join(dir, 'studio.sqlite');
  const store = new Store(file);
  const p = store.createProject('legacy');
  const m = store.createMeeting(p.id, 'legacy');
  m.chats = [{ text: '舊對話', createdAt: 'now' }];
  store.db.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(m), m.id);
  const run = {
    id: 'oldrun',
    meetingId: m.id,
    version: 0,
    status: 'proposed',
    notes: '舊提案',
    startedAt: 'now',
    events: [{ type: 'proposal', notes: '舊提案' }],
  };
  store.db.prepare('INSERT INTO runs VALUES (?,?,?)').run(run.id, m.id, JSON.stringify(run));
  store.close();
  for (let i = 0; i < 2; i++) {
    const migrated = new Store(file);
    assert.equal(migrated.get('meetings', m.id).chats.length, 1);
    assert.equal(migrated.get('runs', 'oldrun').events.length, 1);
    migrated.close();
  }
});
