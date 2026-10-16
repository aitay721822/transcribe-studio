const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OpenAiAdapter } = require('../../dist/ai/adapters/openai.cjs');

const message = (text) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});

const response = (output) => ({
  ok: true,

  json: async () => ({ status: 'completed', output }),
});

test('OpenAI compaction preserves current request, paired recent calls, raw outputs and budgets', async (t) => {
  for (const failure of [false, true]) {
    const requests = [],
      events = [];
    let modelCalls = 0;
    t.mock.method(global, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.tools.length === 0)
        return failure
          ? { ok: false, status: 503 }
          : response([message('已讀第一頁；nextOffset=60；來源[s1]')]);
      if (++modelCalls <= 2)
        return response([
          { type: 'function_call', call_id: `call-${modelCalls}`, name: 'read', arguments: '{}' },
        ]);
      return response([message('完成')]);
    });
    const controller = new AbortController();
    const result = await new OpenAiAdapter().execute({
      prompt: '本次要求與原稿必須保留',
      instructions: '規範',
      maxSteps: 4,
      controller,
      signal: controller.signal,
      settings: {
        llm: {
          model: 'test',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'test',
          compactThreshold: 12000,
        },
      },
      tools: {
        specs: () => [{ name: 'read' }],

        call: async () => ({ text: '原始資料'.repeat(4000), nextOffset: 60 }),
      },

      emit: (e) => events.push(e),
    });
    assert.equal(result, '完成');
    assert.equal(requests.length, 4);
    const summaryRequest = requests.find((r) => !r.tools.length);
    assert.match(summaryRequest.input[0].content, /原始資料/);
    const last = requests.at(-1).input;
    assert.equal(last[0].content, '本次要求與原稿必須保留');
    assert.ok(last.some((i) => i.type === 'function_call' && i.call_id === 'call-2'));
    assert.ok(last.some((i) => i.type === 'function_call_output' && i.call_id === 'call-2'));
    assert.equal(
      last.some((i) => i.call_id === 'call-1'),
      failure
    );
    assert.equal(
      events.filter((e) => e.type === 'compaction').at(-1).status,
      failure ? 'error' : 'completed'
    );
    t.mock.restoreAll();
  }
});
test('automatic compaction does not use the last reserved model request', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools.length, 1);
    if (++calls <= 2)
      return response([
        { type: 'function_call', call_id: `c${calls}`, name: 'read', arguments: '{}' },
      ]);
    return response([message('完成')]);
  });
  const controller = new AbortController();
  assert.equal(
    await new OpenAiAdapter().execute({
      prompt: '要求',
      instructions: '規範',
      maxSteps: 3,
      signal: controller.signal,
      settings: {
        llm: { model: 'test', baseUrl: 'https://fixture.invalid', compactThreshold: 12000 },
      },
      tools: {
        specs: () => [{ name: 'read' }],

        call: async () => 'data'.repeat(4000),
      },

      emit: () => {},
    }),
    '完成'
  );
  assert.equal(calls, 3);
});
