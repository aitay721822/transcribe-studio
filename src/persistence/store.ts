import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NoteAnnotation } from '../domain/annotations';
import {
  assertAnnotationScope,
  rebaseAnnotations,
  validateAnnotations,
} from '../domain/annotations';
import type {
  AgentRun,
  Meeting,
  Project,
  Recording,
  Settings,
  TranscriptSegment,
} from '../domain/models';
import { AsrRepository } from './asr/repository';
import { ConversationRepository } from './conversations';

export const DEFAULTS: Settings = {
  theme: 'system',
  llm: {
    backend: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    apiKey: '',
    maxSteps: 20,
    timeoutMinutes: 30,
    codexPath: '',
    claudeKey: '',
    claudeModel: '',
    claudePath: '',
  },
  asr: {
    provider: 'transcriptions',
    realtimeFlavor: 'openai',
    url: 'wss://api.openai.com/v1/realtime?intent=transcription',
    model: 'gpt-live-transcribe',
    fileModel: 'whisper-1',
    fileUrl: 'https://api.openai.com/v1/audio/transcriptions',
    fileHeaders: {},
    fileApiKey: '',
    chunkSeconds: 5,
    apiKey: '',
    language: 'zh',
    sampleRate: 24000,
    headers: {},
    init: {},
    audioMode: 'binary',
    audioField: 'audio',
    audioEnvelope: {},
    mapping: {
      text: 'text',
      id: 'id',
      final: 'final',
      speaker: 'speaker',
      start: 'start',
      end: 'end',
    },
    signalingUrl: '',
    signalingMode: 'json',
    channel: 'transcript',
    iceServers: [],
  },
  mcp: [],
};

export interface Revision {
  id: string;
  meetingId: string;
  notes: string;
  version: number;
  createdAt: string;
}
type Tables = { projects: Project; meetings: Meeting; revisions: Revision; runs: AgentRun };
export class Store {
  readonly transcriptions: AsrRepository;
  readonly conversations: ConversationRepository;
  private db: DatabaseSync;

  constructor(filename: string) {
    const dataDirectory =
      filename === ':memory:'
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'studio-memory-'))
        : path.dirname(filename);
    this.conversations = new ConversationRepository(path.join(dataDirectory, 'conversations'));
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, data TEXT NOT NULL);`);
    this.transcriptions = new AsrRepository(this.db);
    // Idempotent migration: durable JSONL append completes before clearing legacy columns.
    for (const row of this.db.prepare('SELECT data FROM meetings').all()) {
      const meeting: Meeting = JSON.parse(String(row.data));
      this.conversations.read(meeting.id);
      if (meeting.chats?.length) {
        this.conversations.syncMessages(meeting.id, meeting.chats);
        this.putMeeting(meeting);
      }
    }
    for (const row of this.db.prepare('SELECT data FROM runs').all())
      this.conversations.saveRun(JSON.parse(String(row.data)));
    this.db.exec('DELETE FROM runs');
  }

  hydrate<T extends keyof Tables>(table: T, data: Tables[T]): Tables[T] {
    return table === 'meetings'
      ? {
          ...data,
          chats: this.conversations.messages(data.id),
          agentSessions: this.conversations.sessions(data.id),
          contextMemory: this.conversations.memory(data.id),
          agentHistory: this.conversations.runs(data.id).map((r) => ({
            runId: r.id,
            status: r.status,
            version: r.version,
            notes: r.notes,
            answer: r.events?.find((event) => event.type === 'answer')?.message,
            messageId: r.input?.messageId,
            started: r.events?.some((event) => event.type === 'started'),
            createdAt: r.startedAt,
          })),
        }
      : data;
  }

  list<T extends keyof Tables>(table: T): Tables[T][] {
    if (table === 'runs')
      return this.meetings().flatMap((m) => this.conversations.runs(m.id)) as Tables[T][];
    if (!['projects', 'meetings', 'revisions'].includes(table)) throw new Error('無效的資料表');
    return this.db
      .prepare(`SELECT data FROM ${table}`)
      .all()
      .map((r) => this.hydrate(table, JSON.parse(String(r.data))));
  }

  get<T extends keyof Tables>(table: T, id: string): Tables[T] {
    if (table === 'runs') return (this.list('runs').find((r) => r.id === id) || null) as Tables[T];
    if (!['projects', 'meetings', 'revisions'].includes(table)) throw new Error('無效的資料表');
    const r = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return r ? this.hydrate(table, JSON.parse(String(r.data))) : null;
  }

  projects() {
    return this.list('projects');
  }

  meetings() {
    return this.list('meetings').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createProject(name: string): Project {
    if (!String(name).trim()) throw new Error('請輸入專案名稱');
    const p: Project = {
      id: randomUUID(),
      name: String(name).trim().slice(0, 120),
      roots: [],
      createdAt: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO projects VALUES (?,?)').run(p.id, JSON.stringify(p));
    return p;
  }

  updateProject(id: string, patch: Partial<Project>) {
    const p = this.get('projects', id);
    if (!p) throw new Error('找不到專案');
    if ('name' in patch && !String(patch.name).trim()) throw new Error('請輸入專案名稱');
    const next = {
      ...p,
      ...patch,
      id,
      name: String(patch.name ?? p.name)
        .trim()
        .slice(0, 120),
    };
    this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(next), id);
    return next;
  }

  deleteProject(id: string) {
    if (!this.get('projects', id)) throw new Error('找不到專案');
    const meetings = this.meetings().filter((m) => m.projectId === id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const meeting of meetings) {
        this.db.prepare('DELETE FROM revisions WHERE meeting_id=?').run(meeting.id);
        this.db.prepare('DELETE FROM runs WHERE meeting_id=?').run(meeting.id);
      }
      this.db.prepare('DELETE FROM meetings WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      this.db.exec('ROLLBACK');
      throw error;
    }
    return meetings;
  }

  deleteMeeting(id: string) {
    if (!this.get('meetings', id)) throw new Error('找不到會議');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM revisions WHERE meeting_id=?').run(id);
      this.db.prepare('DELETE FROM runs WHERE meeting_id=?').run(id);
      this.db.prepare('DELETE FROM meetings WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createMeeting(projectId: string, title: string, source = 'live'): Meeting {
    if (!this.get('projects', projectId)) throw new Error('請先建立專案');
    if (this.get('projects', projectId).archivedAt) throw new Error('請先解除封存專案再建立會議');
    const now = new Date().toISOString();
    const m: Meeting = {
      id: randomUUID(),
      projectId,
      title: String(title || '未命名會議').slice(0, 160),
      source,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      duration: 0,
      segments: [],
      notes: '',
      version: 0,
      recordings: [],
      markers: [],
      chats: [],
      references: [],
    };
    this.db.prepare('INSERT INTO meetings VALUES (?,?,?)').run(m.id, projectId, JSON.stringify(m));
    return m;
  }

  updateMeeting(
    id: string,
    patch: Partial<Meeting>,
    expectedVersion?: number,
    expectedAnnotations?: NoteAnnotation[]
  ) {
    const m = this.get('meetings', id);
    if (!m) throw new Error('找不到會議');
    if (expectedVersion !== undefined && expectedVersion !== m.version)
      throw new Error('文件已有新版本，請重新整理後再套用修訂');
    if (expectedAnnotations !== undefined)
      assertAnnotationScope(m.notes, m.annotations || [], expectedAnnotations);
    const allowed = [
      'title',
      'status',
      'duration',
      'notes',
      'markers',
      'chats',
      'references',
      'agentSessions',
      'annotations',
    ] as const;
    const next = { ...m };
    for (const k of allowed) if (k in patch) Object.assign(next, { [k]: patch[k] });
    next.annotations =
      'annotations' in patch
        ? validateAnnotations(patch.annotations, next.notes)
        : rebaseAnnotations(m.annotations || [], m.notes, next.notes);
    if ('notes' in patch && patch.notes !== m.notes) {
      const rev = {
        id: randomUUID(),
        meetingId: id,
        notes: m.notes,
        version: m.version,
        createdAt: new Date().toISOString(),
      };
      this.db.prepare('INSERT INTO revisions VALUES (?,?,?)').run(rev.id, id, JSON.stringify(rev));
      next.version++;
    }
    next.updatedAt = new Date().toISOString();
    this.putMeeting(next);
    return next;
  }

  putMeeting(m: Meeting) {
    this.conversations.syncMessages(m.id, m.chats || []);
    const existing = this.conversations.sessions(m.id);
    for (const [backend, binding] of Object.entries(m.agentSessions || {}))
      if (JSON.stringify(binding) !== JSON.stringify(existing[backend]))
        this.conversations.append(m.id, 'session', { backend, binding });
    const { chats, agentSessions, agentHistory, contextMemory, ...data } = m;
    this.db.prepare('UPDATE meetings SET data=? WHERE id=?').run(JSON.stringify(data), m.id);
  }

  segment(id: string, seg: TranscriptSegment) {
    const m = this.get('meetings', id);
    if (!m) throw new Error('找不到會議');
    const i = m.segments.findIndex((s) => s.id === seg.id);
    if (i >= 0 && m.segments[i].final && !seg.final) return m;
    if (i >= 0) m.segments[i] = { ...m.segments[i], ...seg };
    else m.segments.push(seg);
    m.segments.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
    m.updatedAt = new Date().toISOString();
    this.putMeeting(m);
    return m;
  }

  recording(id: string, record: Recording) {
    const m = this.get('meetings', id);
    m.recordings.push(record);
    this.putMeeting(m);
    return m;
  }

  settings(): Settings {
    const data = this.settingsRecord();
    return data ? JSON.parse(data) : structuredClone(DEFAULTS);
  }

  saveSettings(s: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1,?)').run(JSON.stringify(s));
  }

  settingsRecord(): string | undefined {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get();
    return row ? String(row.data) : undefined;
  }

  saveSettingsRecord(ciphertext: string, purgeLegacy = false) {
    if (!ciphertext.startsWith('protected-settings:v2:')) throw new Error('禁止寫入明文憑證設定');
    this.db.exec('PRAGMA secure_delete=ON');
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1,?)').run(ciphertext);
    if (purgeLegacy)
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }

  revisionList(id: string) {
    return this.list('revisions')
      .filter((r) => r.meetingId === id)
      .sort((a, b) => b.version - a.version);
  }

  saveRun(run: AgentRun) {
    this.conversations.saveRun(run);
  }

  queuedRuns() {
    return this.list('runs').filter((run) => run.status === 'queued');
  }

  recover() {
    this.transcriptions.recover();
    for (const m of this.meetings())
      if (['recording', 'transcribing'].includes(m.status))
        this.updateMeeting(m.id, { status: 'interrupted' });
    for (const run of this.list('runs'))
      if (run.status === 'running') {
        run.status = 'cancelled';
        run.events.push({ type: 'error', message: '上次執行因程式結束而中斷' });
        this.saveRun(run);
      }
  }

  close() {
    this.db.close();
  }
}
