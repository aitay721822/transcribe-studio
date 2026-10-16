const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');
const { Agent } = require('../../dist/harness/coordinator.cjs');
const { compactConversation } = require('../../dist/harness/context/compact.cjs');
const { makePrompt } = require('../../dist/harness/prompt.cjs');

test('compression settings validate bounds and persist explicit disabling', () => {
  const { compressionSettings } = require('../../dist/domain/agents/compression.cjs');

  assert.deepEqual(compressionSettings({}), { autoCompact: true, compactThreshold: 60000 });
  assert.deepEqual(compressionSettings({ autoCompact: false, compactThreshold: 12000 }), {
    autoCompact: false,
    compactThreshold: 12000,
  });
  for (const compactThreshold of [0, 11999, 1000001, 12000.5, NaN, Infinity])
    assert.throws(() => compressionSettings({ compactThreshold }));
});

function fixture() {
  const store = new Store(':memory:');
  const p = store.createProject('context');
  let m = store.createMeeting(p.id, 'meeting');
  m = store.updateMeeting(m.id, {
    notes: '目前有效的紀錄',
    chats: [{ text: '保留需求'.repeat(13000), createdAt: 'now' }].map((v) => ({
      ...v,
      text: v.text.slice(0, 15000),
    })),
    agentSessions: { codex: { id: 'old', fingerprint: 'old' } },
  });
  store.saveRun({
    id: 'old-run',
    meetingId: m.id,
    status: 'proposed',
    version: m.version,
    startedAt: 'now',
    notes: '舊提案',
    events: [
      { type: 'tool', name: 'studio_read_transcript', args: { offset: 0, limit: 60 } },
      {
        type: 'tool-result',
        name: 'studio_read_transcript',
        result: { nextOffset: 60, text: '來源完整內容'.repeat(18000) },
      },
    ],
  });
  const controller = new AbortController(),
    events = [];
  const ctx = {
    meeting: store.get('meetings', m.id),
    controller,
    signal: controller.signal,

    emit: (e) => events.push(e),
  };
  return { store, m, ctx, events };
}

test('manual compaction processes all bounded batches, keeps raw journal and invalidates native sessions only on commit', async () => {
  const { store, m, ctx, events } = fixture();
  try {
    const raw = store.conversations.read(m.id);
    const expected = store.conversations
      .context(m.id)
      .map((r) => JSON.stringify({ type: r.type, data: r.data }))
      .join('\n');
    const chunks = [];
    await compactConversation(
      ctx,
      {
        execute: async (c) => {
          assert.equal(c.ephemeral, true);
          assert.equal(c.maxSteps, 1);
          assert.deepEqual(c.tools.specs(), []);
          const p = JSON.parse(c.prompt);
          chunks.push(p.data);
          if (chunks.length === 1)
            store.updateMeeting(m.id, {
              chats: [
                ...store.get('meetings', m.id).chats,
                { text: '壓縮期間新增的訊息', createdAt: 'later' },
              ],
            });
          return '待辦：小明週五完成；已讀 offset 0–59；nextOffset=60；來源 [segment-a]。';
        },
      },
      store,
      20
    );
    assert.equal(chunks.join(''), expected);
    assert.ok(chunks.length > 1);
    assert.deepEqual(store.conversations.read(m.id).slice(0, raw.length), raw);
    const fresh = store.get('meetings', m.id);
    assert.deepEqual(fresh.agentSessions, {});
    const prompt = JSON.parse(makePrompt({ meetingId: m.id, instruction: '繼續' }, fresh, []));
    assert.match(prompt.contextSummary, /nextOffset=60/);
    assert.deepEqual(prompt.recentConversation, [{ text: '壓縮期間新增的訊息' }]);
    assert.equal(prompt.currentNotes, '目前有效的紀錄');
    assert.ok(
      store.conversations
        .context(m.id)
        .some((r) => r.type === 'message' && r.data.text === '壓縮期間新增的訊息')
    );
    assert.equal(events.at(-1).status, 'completed');
  } finally {
    store.close();
  }
});
test('failed or cancelled multi-batch compaction never replaces memory or native binding', async () => {
  for (const cancel of [false, true]) {
    const { store, m, ctx } = fixture();
    let calls = 0;
    try {
      await assert.rejects(
        compactConversation(
          ctx,
          {
            execute: async () => {
              if (++calls === 2) {
                if (cancel) ctx.controller.abort(new Error('stop'));
                throw new Error('失敗');
              }
              return '摘要';
            },
          },
          store,
          20
        )
      );
      assert.equal(store.conversations.memory(m.id), undefined);
      assert.equal(store.get('meetings', m.id).agentSessions.codex.id, 'old');
      assert.equal(store.conversations.messages(m.id).length, 1);
    } finally {
      store.close();
    }
  }
});
test('clear resets visible chat, summaries, runs and sessions while preserving source, notes, and archived raw output', () => {
  const { store, m } = fixture();
  try {
    store.segment(m.id, { id: 'source', text: '原始逐字稿', start: 0, end: 1, final: true });
    store.conversations.append(m.id, 'context-memory', { summary: '摘要', messageCount: 1 });
    const before = store.conversations.read(m.id);
    store.conversations.append(m.id, 'conversation-reset', { reason: '/clear' });
    const fresh = store.get('meetings', m.id);
    assert.deepEqual(fresh.chats, []);
    assert.deepEqual(fresh.agentSessions, {});
    assert.deepEqual(fresh.agentHistory, []);
    assert.equal(fresh.contextMemory, undefined);
    assert.equal(fresh.notes, m.notes);
    assert.equal(fresh.segments[0].text, '原始逐字稿');
    assert.deepEqual(store.conversations.read(m.id).slice(0, before.length), before);
    store.updateMeeting(m.id, { chats: [{ text: '全新對話', createdAt: 'later' }] });
    assert.equal(store.get('meetings', m.id).chats[0].text, '全新對話');
  } finally {
    store.close();
  }
});
test('automatic conversation summaries share the model budget; failed summary is counted and normal work can continue', async () => {
  const { store, m } = fixture();
  const s = structuredClone(DEFAULTS);
  Object.assign(s.llm, {
    model: 'fixture',
    apiKey: 'fixture',
    maxSteps: 2,
    compactThreshold: 12000,
  });
  store.saveSettings(s);
  // Use one batch so the two-request budget can summarize and produce the answer.
  store.conversations.append(m.id, 'context-memory', {
    summary: '已讀資料',
    messageCount: 1,
    throughId: store.conversations.context(m.id).at(-1).id,
  });
  store.saveRun({
    id: 'new-run',
    meetingId: m.id,
    status: 'failed',
    version: m.version,
    startedAt: 'later',
    events: [{ type: 'tool-result', result: '資料'.repeat(7000) }],
  });
  const calls = [];
  const agent = new Agent(store, '', () => {}, undefined, [
    {
      id: 'openai',

      execute: async (ctx) => {
        calls.push({ ephemeral: ctx.ephemeral, budget: ctx.maxSteps });
        if (ctx.ephemeral) throw new Error('summary unavailable');
        return '完成';
      },
    },
  ]);
  try {
    const run = await agent.run({ meetingId: m.id, instruction: '繼續' });
    assert.equal(run.status, 'proposed');
    assert.equal(run.notes, '完成');
    assert.deepEqual(calls, [
      { ephemeral: true, budget: 1 },
      { ephemeral: undefined, budget: 1 },
    ]);
  } finally {
    await agent.close();
    store.close();
  }
});
test('manual command uses the selected backend in ephemeral mode and emits no editable proposal', async () => {
  for (const backend of ['openai', 'codex', 'claude']) {
    const { store, m } = fixture();
    const settings = structuredClone(DEFAULTS);
    Object.assign(settings.llm, {
      backend,
      model: 'fixture',
      apiKey: 'fixture',
      claudeKey: 'fixture',
      claudeModel: 'fixture',
    });
    store.saveSettings(settings);
    let requests = 0;
    const agent = new Agent(store, '', () => {}, undefined, [
      {
        id: backend,

        execute: async (ctx) => {
          assert.equal(ctx.ephemeral, true);
          assert.deepEqual(ctx.tools.specs(), []);
          requests++;
          return '保留要求、進度與來源；nextOffset=60。';
        },
      },
    ]);
    try {
      const run = await agent.run({ meetingId: m.id, command: 'compact', instruction: '壓縮' });
      assert.equal(run.status, 'proposed');
      assert.equal(run.notes, undefined);
      assert.ok(requests > 1);
      assert.ok(!run.events.some((e) => e.type === 'proposal'));
      assert.ok(run.events.some((e) => e.type === 'context-completed'));
      assert.match(store.get('meetings', m.id).contextMemory.summary, /nextOffset/);
    } finally {
      await agent.close();
      store.close();
    }
  }
});
