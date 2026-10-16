const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  rebaseAnnotations,
  annotationTargets,
  assertAnnotationScope,
} = require('../../dist/domain/annotations.cjs');
const { annotationRevision } = require('../../dist/harness/revisions/annotations.cjs');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');
const { Agent } = require('../../dist/harness/coordinator.cjs');

const mark = (notes, quote, id = 'mark', start = notes.indexOf(quote)) => ({
  id,
  start,
  end: start + quote.length,
  quote,
  comment: '補上負責人',
  status: 'pending',
  createdAt: new Date().toISOString(),
});

test('a marked steer queues a scoped turn and revalidates before execution', async () => {
  const store = new Store(':memory:'),
    project = store.createProject('marked queue');
  const initial = store.createMeeting(project.id, 'queue'),
    notes = '保持前文\n待修訂\n保持後文';
  const target = mark(notes, '待修訂'),
    meeting = store.updateMeeting(initial.id, { notes, annotations: [target] });
  const settings = structuredClone(DEFAULTS);
  settings.llm.apiKey = 'fixture';
  settings.llm.model = 'fixture';
  store.saveSettings(settings);
  let release,
    start,
    steers = 0,
    executions = 0;
  const started = new Promise((r) => {
      start = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const agent = new Agent(store, path.join(__dirname, '../../skills'), () => {}, undefined, [
    {
      id: 'openai',

      async execute(ctx) {
        executions++;
        ctx.bindSteer(async () => {
          steers++;
          return true;
        });
        start();
        await gate;
        return notes;
      },
    },
  ]);
  try {
    const first = agent.run({ meetingId: meeting.id, instruction: '一般修訂' });
    await started;
    const result = await agent.submit(
      { meetingId: meeting.id, instruction: '標記修訂', annotationIds: [target.id] },
      'steer',
      agent.inputState(meeting.id).activeRunId
    );
    assert.equal(result.disposition, 'queued');
    assert.equal(steers, 0);
    store.updateMeeting(meeting.id, { notes: notes.replace('待修訂', '已修改') });
    release();
    await first;
    for (let i = 0; i < 200 && store.get('runs', result.id).status !== 'failed'; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.get('runs', result.id).status, 'failed');
    assert.equal(executions, 1);
    assert.match(store.get('runs', result.id).events.at(-1).message, /原文已變動/);
  } finally {
    release();
    await agent.close();
    store.close();
  }
});

test('annotations persist, shift outside edits, invalidate intersecting edits and distinguish duplicate quotes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-marks-')),
    file = path.join(dir, 'studio.sqlite');
  let store = new Store(file);
  try {
    const project = store.createProject('marks'),
      meeting = store.createMeeting(project.id, 'marks');
    const notes = '# 紀錄\n重複文字\n不變內容\n重複文字\n結尾';
    const target = mark(notes, '重複文字', 'second', notes.lastIndexOf('重複文字'));
    const saved = store.updateMeeting(meeting.id, { notes, annotations: [target] }, 0);
    assertAnnotationScope(notes, [target], [target]);
    assert.throws(
      () => assertAnnotationScope(notes, [{ ...target, comment: '新的指示' }], [target]),
      /新的修改指示/
    );
    assert.throws(
      () =>
        store.updateMeeting(meeting.id, { notes: '不可套用' }, saved.version, [
          { ...target, comment: '不同指示' },
        ]),
      /新的修改指示/
    );
    assert.equal(store.get('meetings', meeting.id).notes, notes);
    assert.throws(
      () => store.updateMeeting(meeting.id, { annotations: [{ ...target, quote: '不存在' }] }),
      /原文/
    );
    assert.throws(() => annotationTargets(notes, [target], []), /無效/);
    assert.throws(() => annotationTargets(notes, [target], ['second', 'second']), /無效/);
    let next = store.updateMeeting(meeting.id, { notes: `前言\n${notes}` }, saved.version);
    assert.equal(next.annotations[0].start, target.start + 3);
    assert.equal(next.annotations[0].status, 'pending');
    store.close();
    store = new Store(file);
    next = store.get('meetings', meeting.id);
    assert.equal(next.annotations[0].quote, target.quote);
    const changed =
      next.notes.slice(0, next.annotations[0].start) +
      '替換後' +
      next.notes.slice(next.annotations[0].end);
    next = store.updateMeeting(meeting.id, { notes: changed }, next.version);
    assert.equal(next.annotations[0].status, 'stale');
    assert.throws(() => annotationTargets(next.notes, next.annotations, ['second']), /變動/);
    assert.equal(rebaseAnnotations([target], notes, `${notes}\n新增結尾`)[0].start, target.start);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('marked replacements preserve every unmarked byte and reject unknown, duplicate, missing or overlapping targets', () => {
  const notes = '# 紀錄\n原文 A\n\n保留 **Markdown**\n\n原文 A\n末尾';
  const a = mark(notes, '原文 A', 'a'),
    b = mark(notes, '原文 A', 'b', notes.lastIndexOf('原文 A'));
  const revision = annotationRevision(
    { annotationIds: ['b', 'a'] },
    { notes, annotations: [a, b] }
  );
  assert.equal(
    revision.parse(
      JSON.stringify({
        replacements: [
          { id: 'b', text: '' },
          { id: 'a', text: '**修改 A**' },
        ],
      })
    ),
    '# 紀錄\n**修改 A**\n\n保留 **Markdown**\n\n\n末尾'
  );
  for (const replacements of [
    [],
    [
      { id: 'a', text: 'a' },
      { id: 'a', text: 'b' },
    ],
    [
      { id: 'a', text: 'a' },
      { id: 'unknown', text: 'b' },
    ],
  ])
    assert.throws(() => revision.parse(JSON.stringify({ replacements })), /標記/);
  assert.throws(
    () => annotationTargets(notes, [a, { ...a, id: 'overlap' }], ['a', 'overlap']),
    /重疊/
  );
});

test('all harness backends receive authoritative marked scope, journal it and propose without changing notes', async () => {
  const store = new Store(':memory:'),
    project = store.createProject('marked');
  const initial = store.createMeeting(project.id, 'marked');
  const notes = '保留開頭\n要修訂\n保留結尾',
    target = mark(notes, '要修訂');
  const meeting = store.updateMeeting(initial.id, { notes, annotations: [target] });
  const adapters = ['openai', 'codex', 'claude'].map((id) => ({
    id,

    async execute(ctx) {
      assert.equal(JSON.parse(ctx.prompt).markedRevisions[0].quote, '要修訂');
      assert.equal(JSON.parse(ctx.prompt).markedRevisions[0].comment, '補上負責人');
      assert(ctx.result.schema.properties.replacements);
      return ctx.result.parse(
        JSON.stringify({ replacements: [{ id: target.id, text: '小明負責' }] })
      );
    },
  }));
  const events = [],
    agent = new Agent(
      store,
      path.join(__dirname, '../../skills'),
      (e) => events.push(e),
      undefined,
      adapters
    );
  try {
    for (const backend of ['openai', 'codex', 'claude']) {
      const s = structuredClone(DEFAULTS);
      s.llm = {
        ...s.llm,
        backend,
        apiKey: 'fixture',
        model: 'fixture',
        claudeKey: 'fixture',
        claudeModel: 'fixture',
      };
      store.saveSettings(s);
      const run = await agent.run({
        meetingId: meeting.id,
        instruction: '依標記修訂',
        annotationIds: [target.id],
      });
      assert.equal(run.status, 'proposed');
      assert.equal(run.notes, '保留開頭\n小明負責\n保留結尾');
      assert.equal(store.get('meetings', meeting.id).notes, notes);
      assert.deepEqual(events.filter((e) => e.type === 'proposal').at(-1).annotationIds, ['mark']);
      assert.equal(
        store.get('runs', run.id).events.find((e) => e.type === 'request').args.markedRevisions[0]
          .comment,
        target.comment
      );
    }
  } finally {
    await agent.close();
    store.close();
  }
});
