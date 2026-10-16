import { randomUUID } from 'node:crypto';
import { summaryInstructions } from '../../domain/agents/compression';
import type { HarnessContext } from '../contracts';
import { textContext } from './multimodal';
import { type ResponseInput, responseData } from './responses';

/** The retained tail starts at a response boundary, keeping calls and outputs paired. */
export async function compactInput(ctx: HarnessContext, input: ResponseInput[], tailStart: number) {
  if (tailStart <= 1) return false;
  const older = input.slice(1, tailStart);
  const data = textContext(older);
  const started = Date.now();
  const callId = randomUUID();
  ctx.emit({
    type: 'compaction',
    callId,
    status: 'running',
    message: '正在壓縮較舊的工具上下文',
    args: { beforeChars: data.length },
  });
  try {
    const response = await fetch(`${ctx.settings.llm.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.settings.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: ctx.settings.llm.model,
        store: false,
        instructions: summaryInstructions,
        input: [{ role: 'user', content: data }],
        tools: [],
        max_output_tokens: 2400,
      }),
    });
    if (!response.ok) throw new Error(`壓縮請求失敗 (${response.status})`);
    const result = responseData(await response.json());
    if (result.error || result.status === 'incomplete') throw new Error('壓縮未完成，保留原上下文');
    const summary = (result.output || [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('\n');
    if (!summary.trim() || summary.length > 8000 || summary.length >= data.length)
      throw new Error('壓縮摘要無效或未縮小，保留原上下文');
    ctx.signal.throwIfAborted();
    // Keep every steering instruction verbatim, in addition to its summary.
    const prefix = '先前上下文摘要（僅供參考；原始來源可用會議工具查閱）：\n';
    const steers = older.filter(
      (item) =>
        item.role === 'user' &&
        !(typeof item.content === 'string' && item.content.startsWith(prefix))
    );
    input.splice(1, tailStart - 1, { role: 'user', content: `${prefix}${summary}` }, ...steers);
    ctx.emit({
      type: 'compaction',
      callId,
      status: 'completed',
      message: '工具上下文壓縮完成 · 完整 output 保留於紀錄',
      durationMs: Date.now() - started,
      args: {
        beforeChars: data.length,
        afterChars: JSON.stringify([{ role: 'user', content: `${prefix}${summary}` }, ...steers])
          .length,
      },
      result: { summary },
    });
    return true;
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

    ctx.emit({
      type: 'compaction',
      callId,
      status: ctx.signal.aborted ? 'cancelled' : 'error',
      message: error.message,
      durationMs: Date.now() - started,
    });
    if (ctx.signal.aborted) throw error;
    return false;
  }
}
