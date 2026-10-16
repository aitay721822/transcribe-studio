import type { AgentEvent } from '../models';
import { record } from '../value';

export interface ToolCallTrace {
  key: string;
  input: AgentEvent;
  output?: AgentEvent;
  progress?: AgentEvent;
  repetition: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record(value)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Also pair older journal records, which did not yet contain per-call ids. */
export function toolCallTraces(events: AgentEvent[]): ToolCallTrace[] {
  const calls: ToolCallTrace[] = [];
  const identified = new Map<string, ToolCallTrace>();
  const repeats = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool') {
      const signature = `${event.runId || ''}:${event.name}:${canonical(event.args)}`;
      const repetition = (repeats.get(signature) || 0) + 1;
      repeats.set(signature, repetition);
      const call = { key: event.callId || event.id || `legacy-${index}`, input: event, repetition };
      calls.push(call);
      if (event.callId) identified.set(event.callId, call);
    } else if (event.type === 'tool-progress') {
      const call = identified.get(event.callId);
      if (call) call.progress = event;
    } else if (event.type === 'tool-result') {
      const call = event.callId
        ? identified.get(event.callId)
        : calls.find(
            (item) =>
              !item.output && item.input.name === event.name && item.input.runId === event.runId
          );
      if (call) call.output = event;
    }
  }
  return calls;
}

export function transcriptCoverage(calls: ToolCallTrace[]) {
  const ids = new Set<string>();
  let total = 0;
  for (const call of calls) {
    if (call.input.name !== 'studio_read_transcript' || record(call.input.args).query) continue;
    const result = record(call.output?.result);
    if (!Array.isArray(result?.segments)) continue;
    total = Math.max(total, Number(result.total) || 0);
    for (const segment of result.segments)
      if (typeof record(segment).id === 'string') ids.add(String(record(segment).id));
  }
  return { received: ids.size, total };
}

export function toolSummary(call: ToolCallTrace): string {
  const args = record(call.input.args);
  const result = call.output ? record(call.output.result) : undefined;
  if (call.input.name === 'studio_read_transcript') {
    const offset = result?.offset ?? args?.offset ?? 0;
    const query = args?.query ? `搜尋「${args.query}」 · ` : '';
    if (Array.isArray(result?.segments))
      return `${query}回傳 ${result.segments.length} 個片段 · offset ${offset} · 共 ${result.total} 個 · nextOffset ${result.nextOffset === null ? 'null（已讀完）' : result.nextOffset}`;
    return `${query}offset ${offset} · limit ${args?.limit ?? 40}`;
  }
  if (result?.error) return String(result.error);
  if (['studio_list_files', 'studio_search_files'].includes(call.input.name)) {
    const statsValue = result?.stats || call.progress?.args;
    const stats = statsValue ? record(statsValue) : undefined;

    const scanStatus = () => {
      if (result) {
        if (result.nextCursor) {
          return '可續掃下一批';
        }
        return '掃描完成';
      }
      return '背景掃描中';
    };

    return stats
      ? `已檢查 ${stats.visited} 個項目 · 已搜尋 ${stats.scannedFiles} 個檔案 · ${stats.matches} 個命中 · ${scanStatus()}${stats.errorCount ? ` · ${stats.errorCount} 個錯誤` : ''}`
      : '背景掃描已授權資料夾';
  }
  if (call.input.name === 'studio_read_file' && result?.text !== undefined)
    return `${result.relative} · offset ${result.offset} · ${result.unit} · nextOffset ${result.nextOffset === null ? 'null（已讀完）' : result.nextOffset}`;
  if (call.input.name === 'studio_read_notes') return '讀取目前紀錄與版本';
  return '展開檢視完整傳入參數與 output';
}
