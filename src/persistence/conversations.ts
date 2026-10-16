import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '../ai/contracts';
import type { AgentEvent, AgentRun, ChatMessage, Meeting } from '../domain/models';

interface RecordData {
  message: ChatMessage;
  'run-event': { runId: string; event: AgentEvent };
  'run-state': Omit<AgentRun, 'events'>;
  session: { backend: string; binding: SessionBinding };
  'context-memory': NonNullable<Meeting['contextMemory']>;
  'conversation-reset': { reason: string };
}
export type ConversationRecord = {
  [K in keyof RecordData]: {
    schemaVersion: 1;
    id: string;
    timestamp: string;
    type: K;
    data: RecordData[K];
  };
}[keyof RecordData];
/** Append-only JSONL journal. SQLite never owns conversation content. */
export class ConversationRepository {
  private volatileRecords = new Map<string, ConversationRecord[]>();

  constructor(
    readonly directory: string,
    private volatile = false
  ) {
    if (!volatile) fs.mkdirSync(directory, { recursive: true });
  }

  filename(meetingId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(meetingId)) throw new Error('無效的對話 ID');
    return path.join(this.directory, `${meetingId}.jsonl`);
  }

  read(meetingId: string): ConversationRecord[] {
    if (this.volatile) return structuredClone(this.volatileRecords.get(meetingId) || []);
    const file = this.filename(meetingId);
    if (!fs.existsSync(file)) return [];
    const bytes = fs.readFileSync(file);
    const records: ConversationRecord[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const boundary = end < 0 ? bytes.length : end;
      const line = bytes.subarray(offset, boundary).toString('utf8').trim();
      try {
        if (line) {
          const record = JSON.parse(line);
          if (record.schemaVersion !== 1 || !record.id || !record.type)
            throw new Error('Invalid record');
          records.push(record);
        }
      } catch {
        // Only an unterminated tail can be repaired; never silently discard interior corruption.
        if (end >= 0) throw new Error(`對話 JSONL 損毀：${meetingId}，offset ${offset}`);
        fs.truncateSync(file, offset);
        return records;
      }
      offset = boundary + 1;
    }
    if (bytes.length && bytes[bytes.length - 1] !== 10) fs.appendFileSync(file, '\n');
    return records;
  }

  append<K extends keyof RecordData>(
    meetingId: string,
    type: K,
    data: RecordData[K],
    id = randomUUID()
  ): void {
    const record = {
      schemaVersion: 1,
      id,
      timestamp: new Date().toISOString(),
      type,
      data,
    } as ConversationRecord;
    if (this.volatile) {
      const records = this.volatileRecords.get(meetingId) || [];
      records.push(structuredClone(record));
      this.volatileRecords.set(meetingId, records);
      return;
    }
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`);
    const fd = fs.openSync(this.filename(meetingId), 'a');
    try {
      let offset = 0;
      while (offset < buffer.length)
        offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  messages(meetingId: string): ChatMessage[] {
    return this.active(meetingId)
      .filter((r) => r.type === 'message')
      .map((r) => r.data);
  }

  syncMessages(meetingId: string, messages: ChatMessage[]): void {
    const existing = this.messages(meetingId);
    if (
      messages.length < existing.length ||
      existing.some((m, i) => JSON.stringify(m) !== JSON.stringify(messages[i]))
    )
      throw new Error('對話紀錄只能追加');
    for (const message of messages.slice(existing.length)) {
      if (typeof message.text !== 'string' || !message.createdAt || message.text.length > 16000)
        throw new Error('對話內容無效或過長');
      if (
        message.images != null &&
        (!Array.isArray(message.images) ||
          message.images.length > 8 ||
          JSON.stringify(message.images).length > 8000)
      )
        throw new Error('對話圖片 metadata 無效或過長');
      if (
        message.references != null &&
        (!Array.isArray(message.references) ||
          message.references.length > 20 ||
          JSON.stringify(message.references).length > 48000)
      )
        throw new Error('對話參考來源無效或過長');
      this.append(meetingId, 'message', message);
    }
  }

  saveRun(run: AgentRun): void {
    const records = this.read(run.meetingId);
    const count = records.filter((r) => r.type === 'run-event' && r.data.runId === run.id).length;
    for (const event of run.events.slice(count))
      this.append(run.meetingId, 'run-event', { runId: run.id, event });
    const { events, ...state } = run;
    const previous = records.filter((r) => r.type === 'run-state' && r.data.id === run.id).at(-1);
    if (!previous || JSON.stringify(previous.data) !== JSON.stringify(state))
      this.append(run.meetingId, 'run-state', state);
  }

  runs(meetingId: string): AgentRun[] {
    const states = new Map<string, Omit<AgentRun, 'events'>>();
    const events = new Map<string, AgentEvent[]>();
    for (const record of this.active(meetingId)) {
      if (record.type === 'run-state') states.set(record.data.id, record.data);
      if (record.type === 'run-event') {
        const list = events.get(record.data.runId) || [];
        list.push(record.data.event);
        events.set(record.data.runId, list);
      }
    }
    return [...states.values()].map((run) => ({ ...run, events: events.get(run.id) || [] }));
  }

  sessions(meetingId: string): Record<string, SessionBinding> {
    let result: Record<string, SessionBinding> = {};
    for (const r of this.active(meetingId)) {
      if (r.type === 'context-memory') result = {};
      if (r.type === 'session') result[r.data.backend] = r.data.binding;
    }
    return result;
  }

  active(meetingId: string): ConversationRecord[] {
    const records = this.read(meetingId);
    let reset = -1;
    for (let i = records.length - 1; i >= 0; i--)
      if (records[i].type === 'conversation-reset') {
        reset = i;
        break;
      }
    return records.slice(reset + 1);
  }

  memory(meetingId: string) {
    return this.active(meetingId)
      .filter((r) => r.type === 'context-memory')
      .at(-1)?.data;
  }

  context(meetingId: string) {
    const records = this.active(meetingId);
    const throughId = this.memory(meetingId)?.throughId;
    const start = throughId ? records.findIndex((r) => r.id === throughId) + 1 : 0;
    return records
      .slice(start)
      .filter(
        (r) =>
          r.type === 'message' ||
          (r.type === 'run-event' &&
            ['request', 'tool', 'tool-result', 'proposal', 'answer', 'steered'].includes(
              r.data.event.type
            ))
      );
  }
}
