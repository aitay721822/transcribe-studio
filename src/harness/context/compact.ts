import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, HarnessContext } from '../../ai/contracts';
import { summaryInstructions } from '../../domain/agents/compression';
import type { AgentStore } from '../../domain/models';
import { notesSchema, parseNotes } from '../prompt';

/** Commit a new memory only after every bounded batch succeeds. Raw JSONL is immutable. */
export async function compactConversation(
  ctx: HarnessContext,
  adapter: HarnessAdapter,
  store: AgentStore,
  maxRequests: number
) {
  const journal = store.conversations;
  if (!journal) throw new Error('對話儲存不支援壓縮');
  const records = journal.context(ctx.meeting.id);
  const messageCount = journal.messages(ctx.meeting.id).length;
  if (!records.length) {
    ctx.emit({ type: 'log', message: '目前沒有需要壓縮的新對話' });
    return;
  }
  const serialized = records.map((r) => JSON.stringify({ type: r.type, data: r.data })).join('\n');
  // Split even a single large output. Every character reaches a batch; never silently truncate.
  const chunks: string[] = [];
  for (let i = 0; i < serialized.length; i += 48000) chunks.push(serialized.slice(i, i + 48000));
  if (chunks.length > maxRequests)
    throw new Error(`壓縮需要 ${chunks.length} 個模型回合，請提高模型回合上限`);
  const started = Date.now();
  const callId = randomUUID();
  let summary = ctx.meeting.contextMemory?.summary || '';
  ctx.emit({
    type: 'compaction',
    callId,
    status: 'running',
    message: '正在壓縮對話上下文',
    args: { beforeChars: serialized.length, batches: chunks.length },
  });
  try {
    for (const [index, chunk] of chunks.entries()) {
      ctx.signal.throwIfAborted();
      ctx.emit({ type: 'log', message: `壓縮上下文 · ${index + 1}/${chunks.length}` });
      summary = await adapter.execute({
        ...ctx,
        ephemeral: true,
        images: [],
        maxSteps: 1,
        instructions: `${summaryInstructions}\n依 JSON Schema 將摘要放在 notes 欄位。`,
        prompt: JSON.stringify({
          previousSummary: summary,
          batch: index + 1,
          totalBatches: chunks.length,
          data: chunk,
        }),
        result: { schema: notesSchema, parse: parseNotes },
        tools: {
          specs: () => [],

          call: async () => {
            throw new Error('壓縮不可使用工具');
          },
        },

        bindSession: () => {},

        bindSteer: undefined,
        bindTurn: undefined,

        emit: () => {},
      });
      if (!summary.trim() || summary.length > 8000)
        throw new Error('壓縮摘要為空白或過長，保留原上下文');
    }
    ctx.signal.throwIfAborted();
    if (summary.length >= serialized.length + (ctx.meeting.contextMemory?.summary.length || 0))
      throw new Error('摘要未縮小上下文，已保留原紀錄');
    journal.append(ctx.meeting.id, 'context-memory', {
      summary,
      messageCount,
      throughId: records.at(-1).id,
    });
    ctx.emit({
      type: 'compaction',
      callId,
      status: 'completed',
      message: '上下文壓縮完成 · 原始紀錄已保留',
      durationMs: Date.now() - started,
      args: { beforeChars: serialized.length, afterChars: summary.length },
      result: { summary },
    });
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

    ctx.emit({
      type: 'compaction',
      callId,
      status: ctx.signal.aborted ? 'cancelled' : 'error',
      message: error.message,
      durationMs: Date.now() - started,
    });
    throw error;
  }
  return chunks.length;
}
