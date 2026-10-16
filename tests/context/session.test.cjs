const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');
const { Agent } = require('../../dist/harness/coordinator.cjs');
const { TemporaryAgents } = require('../../dist/services/agents/conversation/temporary.cjs');
const { ImageVault } = require('../../dist/services/agents/conversation/images.cjs');
const { OpenAiAdapter } = require('../../dist/ai/adapters/openai.cjs');
const { makePrompt } = require('../../dist/harness/prompt.cjs');

const until = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition timed out');
};

function fixture(filename = ':memory:') {
  const store = new Store(filename),
    settings = structuredClone(DEFAULTS);
  settings.llm.apiKey = 'fixture';
  settings.llm.model = 'fixture';
  settings.mcp = [
    { name: 'must-not-connect', enabled: true, transport: 'stdio', command: 'does-not-exist' },
  ];
  store.saveSettings(settings);
  const project = store.createProject('session'),
    meeting = store.createMeeting(project.id, 'session');
  return { store, meeting };
}

test('queued and removed messages never influence a later prompt; the currently executing queued message is included', () => {
  const { store, meeting } = fixture();
  try {
    meeting.chats = ['old', 'cancelled', 'queued', 'current'].map((id) => ({
      id,
      text: id,
      createdAt: 'now',
    }));
    meeting.contextMemory = { summary: 'old summary', messageCount: 1 };
    meeting.agentHistory = [
      { messageId: 'cancelled', status: 'cancelled', started: false },
      { messageId: 'queued', status: 'queued' },
      { messageId: 'current', status: 'queued' },
    ];
    const prompt = JSON.parse(
      makePrompt({ instruction: 'current', messageId: 'current' }, meeting, [])
    );
    assert.deepEqual(
      prompt.recentConversation.map((chat) => chat.text),
      ['current']
    );
    assert.equal(prompt.contextSummary, 'old summary');
  } finally {
    store.close();
  }
});
test('image assets enforce ownership, count and payload limits, persist independently of JSONL and release temporary bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-image-vault-'));
  const meetingId = randomUUID(),
    sessionId = randomUUID();

  const normalize = (bytes) => ({ bytes, width: 1, height: 1 });

  const vault = new ImageVault(directory, normalize);
  try {
    const image = vault.add(meetingId, 'normal.png', Buffer.from('payload'));
    await assert.rejects(vault.load({ meetingId: randomUUID(), images: [image] }), /不屬於/);
    await assert.rejects(vault.prepare({ meetingId, images: Array(9).fill(image) }), /8/);
    await vault.prepare({ meetingId, images: [image] });
    const recovered = new ImageVault(directory, normalize);
    assert.match((await recovered.load({ meetingId, images: [image] }))[0].dataUrl, /base64/);
    const temp = vault.add(meetingId, 'private.png', Buffer.from('private'), sessionId);
    await vault.prepare({ meetingId, sessionId, images: [temp] });
    assert.equal((await fs.readdir(path.join(directory, meetingId))).length, 1);
    vault.clearSession(sessionId);
    await assert.rejects(vault.load({ meetingId, sessionId, images: [temp] }), /清除/);
    const large = [1, 2].map(() =>
      vault.add(meetingId, 'large.png', Buffer.alloc(3 * 1024 * 1024))
    );
    await assert.rejects(vault.prepare({ meetingId, images: large }), /總量/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('read-only uses an answer schema, skips remote tools and never creates a mutable proposal or changes notes', async () => {
  const { store, meeting } = fixture();
  const events = [];
  const agent = new Agent(store, path.resolve('skills'), (e) => events.push(e), undefined, [
    {
      id: 'openai',

      async execute(ctx) {
        assert.match(ctx.instructions, /唯讀模式/);
        assert.ok(ctx.tools.specs().every((tool) => !tool.name.startsWith('studio_mcp_')));
        assert.match((await ctx.tools.call('studio_mcp_write', {})).error, /不存在/);
        return ctx.result.parse('{"answer":"唯讀回答"}');
      },
    },
  ]);
  try {
    const run = await agent.run({ meetingId: meeting.id, instruction: '只讀', mode: 'read' });
    assert.equal(run.status, 'proposed');
    assert.equal(run.notes, undefined);
    assert.ok(events.some((e) => e.type === 'answer' && e.message === '唯讀回答'));
    assert.ok(events.every((e) => e.type !== 'proposal'));
    assert.equal(store.get('meetings', meeting.id).notes, meeting.notes);
    assert.equal(store.get('meetings', meeting.id).agentHistory[0].answer, '唯讀回答');
    await assert.rejects(
      agent.submit({
        meetingId: meeting.id,
        instruction: 'bad',
        mode: 'read',
        annotationIds: ['a'],
      }),
      /不能/
    );
  } finally {
    await agent.close();
    store.close();
  }
});
test('temporary messages, answers, sessions, images and annotations stay out of persistent stores and late events are discarded', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-private-'));
  const { store, meeting } = fixture(path.join(directory, 'studio.sqlite'));
  const images = new ImageVault(path.join(directory, 'attachments'), (bytes) => ({
    bytes,
    width: 1,
    height: 1,
  }));
  let context;
  const emitted = [];
  const temporary = new TemporaryAgents(
    store,
    path.resolve('skills'),
    path.join(directory, 'runtime'),
    (event) => emitted.push(event),
    images,
    [
      {
        id: 'openai',

        async execute(ctx) {
          context = ctx;
          assert.equal(ctx.ephemeral, true);
          assert.equal(ctx.images.length, 1);
          assert.equal(ctx.meeting.chats[0].text, 'private-message');
          await new Promise((_, reject) =>
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
          );
          return 'unused';
        },
      },
    ]
  );
  try {
    const session = temporary.begin(meeting.id),
      current = temporary.get(session.id);
    const image = images.add(meeting.id, 'private.png', Buffer.from('image-payload'), session.id);
    const request = {
      meetingId: meeting.id,
      instruction: 'private-message',
      sessionId: session.id,
      images: [image],
      mode: 'read',
    };
    await images.prepare(request);
    current.store.conversations.syncMessages(meeting.id, [
      { text: 'private-message', createdAt: 'now', images: [image] },
    ]);
    const run = current.agent.run(request);
    await until(() => context);
    current.store.updateMeeting(meeting.id, { annotations: [{ id: 'private-annotation' }] });
    assert.equal(store.get('meetings', meeting.id).annotations?.length || 0, 0);
    const before = store.conversations.read(meeting.id).length;
    await temporary.end(session.id);
    await run;
    assert.throws(() => temporary.get(session.id), /結束/);
    await assert.rejects(images.load(request), /清除/);
    assert.equal(store.conversations.read(meeting.id).length, before);
    assert.deepEqual(
      await fs.readdir(directory),
      ['conversations', 'studio.sqlite', 'studio.sqlite-shm', 'studio.sqlite-wal']
        .filter((name) => true)
        .sort(),
      'only persistent store files exist'
    );
    assert.ok(emitted.every((e) => e.sessionId === session.id));
  } finally {
    await temporary.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('queued promotion retains FIFO on rejection, rejects permission escalation, and forwards images exactly once on acceptance', async () => {
  const { store, meeting } = fixture();
  store.saveSettings({ ...store.settings(), mcp: [] });
  let context,
    accept = false,
    received,
    finish;
  const gate = new Promise((r) => {
    finish = r;
  });
  const picture = {
    id: randomUUID(),
    name: 'image.png',
    mime: 'image/png',
    width: 1,
    height: 1,
    dataUrl: 'data:image/png;base64,aW1hZ2U=',
  };
  const agent = new Agent(
    store,
    path.resolve('skills'),
    () => {},
    undefined,
    [
      {
        id: 'openai',

        async execute(ctx) {
          context = ctx;
          ctx.bindSteer(async (text, images) => {
            received = { text, images };
            return accept;
          });
          await gate;
          return 'answer';
        },
      },
    ],
    { load: async (request) => (request.images || []).map(() => picture) }
  );
  try {
    const first = agent.run({ meetingId: meeting.id, instruction: 'active', mode: 'read' });
    await until(() => context);
    const id = agent.inputState(meeting.id).activeRunId;
    const queued = await agent.submit({
      meetingId: meeting.id,
      instruction: 'queued-image',
      mode: 'read',
      images: [picture],
    });
    assert.equal((await agent.promote(queued.id, id)).disposition, 'queued');
    assert.equal(agent.inputState(meeting.id).queued.length, 1);
    const edit = await agent.submit({ meetingId: meeting.id, instruction: 'edit', mode: 'edit' });
    await assert.rejects(agent.promote(edit.id, id), /權限不同/);
    accept = true;
    assert.equal((await agent.promote(queued.id, id)).disposition, 'steered');
    assert.match(received.text, /queued-image/);
    assert.equal(received.images.length, 1);
    assert.equal(received.images[0].dataUrl, picture.dataUrl);
    agent.cancel(edit.id);
    finish();
    await first;
  } finally {
    finish();
    await agent.close();
    store.close();
  }
});
test('OpenAI receives all initial and steering image parts without treating base64 bytes as text to compress', async (t) => {
  const requests = [];
  let steer;
  t.mock.method(global, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) await steer('follow-image', [image]);
    return {
      ok: true,

      json: async () => ({
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        ],
      }),
    };
  });
  const image = { mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(20000)}` };
  const controller = new AbortController();
  const result = await new OpenAiAdapter().execute({
    prompt: 'look',
    images: [image, image],
    instructions: 'read',
    settings: {
      llm: {
        baseUrl: 'http://fixture.invalid',
        model: 'fixture',
        apiKey: 'fixture',
        compactThreshold: 12000,
      },
    },
    maxSteps: 3,
    tools: {
      specs: () => [],

      call: async () => null,
    },
    controller,
    signal: controller.signal,

    emit: () => {},

    bindSteer: (fn) => {
      if (fn) steer = fn;
    },
  });
  assert.equal(result, 'done');
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].input[0].content.filter((part) => part.type === 'input_image').length,
    2
  );
  assert.equal(
    requests[1].input.at(-1).content.filter((part) => part.type === 'input_image').length,
    1
  );
});
