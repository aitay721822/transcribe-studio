const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../../dist/persistence/store.cjs');
const { removeMeeting } = require('../../dist/services/meetings/lifecycle.cjs');
const { removeProject } = require('../../dist/services/projects/lifecycle.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-lifecycle-alias-'));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await fs.mkdir(actual);
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = new Store(path.join(alias, 'studio.sqlite'));
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('studio-lifecycle-alias-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = store.createProject('Alias root');
  const meeting = store.createMeeting(project.id, 'Alias meeting');
  await fs.mkdir(path.join(alias, 'audio'));
  const audio = path.join(alias, 'audio', 'recording.webm');
  await fs.writeFile(audio, 'recording');
  store.recording(meeting.id, { id: 'audio', path: audio });
  store.updateMeeting(meeting.id, { chats: [{ text: 'chat', createdAt: 'now' }] });
  return { root, alias, actual, store, project, meeting, audio };
}

test('meeting deletion accepts an aliased data root and deletes its owned audio and journal', async (t) => {
  const f = await fixture(t);
  const result = await removeMeeting(f.store, f.alias, f.meeting.id);
  assert.deepEqual(result.warnings, []);
  assert.equal(f.store.get('meetings', f.meeting.id), null);
  await assert.rejects(fs.access(f.audio), { code: 'ENOENT' });
  await assert.rejects(fs.access(f.store.conversations.filename(f.meeting.id)), { code: 'ENOENT' });
});

test('project deletion accepts an aliased data root including its runtime directories', async (t) => {
  const f = await fixture(t);
  const runtime = path.join(f.alias, 'runtime', 'projects', f.project.id);
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(runtime, 'session.jsonl'), 'session');
  const result = await removeProject(f.store, f.alias, f.project.id);
  assert.deepEqual(result.warnings, []);
  assert.equal(f.store.get('projects', f.project.id), null);
  await assert.rejects(fs.access(f.audio), { code: 'ENOENT' });
  await assert.rejects(fs.access(runtime), { code: 'ENOENT' });
});

test('an aliased data root still rejects audio redirected outside the owned directory', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  const audioRoot = path.join(f.alias, 'audio');
  await fs.unlink(f.audio);
  await fs.rmdir(audioRoot);
  await fs.symlink(outside, audioRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(f.audio, 'keep');
  await assert.rejects(removeMeeting(f.store, f.alias, f.meeting.id), /目錄外/);
  await assert.rejects(removeProject(f.store, f.alias, f.project.id), /目錄外/);
  assert(f.store.get('meetings', f.meeting.id));
  assert.equal(await fs.readFile(f.audio, 'utf8'), 'keep');
});

test('an aliased data root still rejects runtime redirected outside the owned directory', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside-runtime');
  await fs.mkdir(outside);
  const parent = path.join(f.alias, 'runtime', 'projects');
  await fs.mkdir(parent, { recursive: true });
  await fs.symlink(
    outside,
    path.join(parent, f.project.id),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await fs.writeFile(path.join(outside, 'session.jsonl'), 'keep');
  await assert.rejects(removeProject(f.store, f.alias, f.project.id), /目錄外/);
  assert(f.store.get('projects', f.project.id));
  assert.equal(await fs.readFile(path.join(outside, 'session.jsonl'), 'utf8'), 'keep');
});
