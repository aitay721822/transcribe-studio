import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  type AsrChunk,
  type AsrTask,
  chunkSchema,
  type ServiceHealth,
  taskFailure,
  taskSchema,
} from '../../domain/asr/tasks';

const healthSchema = z.object({
  id: z.string(),
  failures: z.number(),
  nextAttemptAt: z.number(),
  notBefore: z.number(),
  error: taskFailure.optional(),
});

export class TaskStorage {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS asr_tasks (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, project_id TEXT NOT NULL,
        service_id TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
        deleted INTEGER NOT NULL, next_at REAL NOT NULL, updated_at REAL NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS asr_tasks_schedule ON asr_tasks(deleted, state, next_at);
      CREATE INDEX IF NOT EXISTS asr_tasks_meeting ON asr_tasks(meeting_id, deleted, updated_at);
      CREATE TABLE IF NOT EXISTS asr_chunks (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES asr_tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, state TEXT NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL,
        UNIQUE(task_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS asr_chunks_schedule ON asr_chunks(task_id, state, sequence);
      CREATE TABLE IF NOT EXISTS asr_services (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asr_controls (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asr_coverage (recording_id TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL,
        PRIMARY KEY(recording_id,start));
    `);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  task(id: string): AsrTask | undefined {
    const row = this.db.prepare('SELECT data FROM asr_tasks WHERE id=?').get(id);
    return row ? taskSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  saveTask(task: AsrTask): void {
    const value = taskSchema.parse(task);
    this.db
      .prepare(`INSERT INTO asr_tasks VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET service_id=excluded.service_id, state=excluded.state,
      deleted=excluded.deleted, next_at=excluded.next_at, updated_at=excluded.updated_at, data=excluded.data`)
      .run(
        value.id,
        value.meetingId,
        value.projectId,
        value.serviceId,
        value.source,
        value.state,
        Number(value.deleted),
        value.nextAttemptAt,
        value.updatedAt,
        JSON.stringify(value)
      );
  }

  chunk(id: string): AsrChunk | undefined {
    const row = this.db.prepare('SELECT data FROM asr_chunks WHERE id=?').get(id);
    return row ? chunkSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  chunkAt(taskId: string, index: number): AsrChunk | undefined {
    const row = this.db
      .prepare('SELECT data FROM asr_chunks WHERE task_id=? AND sequence=?')
      .get(taskId, index);
    return row ? chunkSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  saveChunk(chunk: AsrChunk): void {
    const value = chunkSchema.parse(chunk);
    this.db
      .prepare(`INSERT INTO asr_chunks VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      state=excluded.state, bytes=excluded.bytes, data=excluded.data`)
      .run(value.id, value.taskId, value.index, value.state, value.bytes, JSON.stringify(value));
  }

  chunks(taskId: string, offset = 0, limit = 100): AsrChunk[] {
    return this.db
      .prepare('SELECT data FROM asr_chunks WHERE task_id=? ORDER BY sequence LIMIT ? OFFSET ?')
      .all(taskId, limit, offset)
      .map((row) => chunkSchema.parse(JSON.parse(String(row.data))));
  }

  health(id: string): ServiceHealth {
    const row = this.db.prepare('SELECT data FROM asr_services WHERE id=?').get(id);
    if (!row) return { id, failures: 0, nextAttemptAt: 0, notBefore: 0 };
    return healthSchema.parse(JSON.parse(String(row.data)));
  }

  saveHealth(health: ServiceHealth): void {
    this.db
      .prepare('INSERT OR REPLACE INTO asr_services VALUES (?,?)')
      .run(health.id, JSON.stringify(healthSchema.parse(health)));
  }

  control(id: string, fallback = false): boolean {
    const row = this.db.prepare('SELECT data FROM asr_controls WHERE id=?').get(id);
    return row ? z.boolean().parse(JSON.parse(String(row.data))) : fallback;
  }

  saveControl(id: string, value: boolean): void {
    this.db
      .prepare('INSERT OR REPLACE INTO asr_controls VALUES (?,?)')
      .run(id, JSON.stringify(value));
  }
}
