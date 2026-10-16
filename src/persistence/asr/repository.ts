import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { FailureInfo } from '../../domain/asr/retry';
import { retryDelay } from '../../domain/asr/retry';
import {
  type AsrChunk,
  type AsrTask,
  chunkSchema,
  isTaskActive,
  type TaskAction,
  type TaskFilter,
  type TaskPage,
  taskSchema,
} from '../../domain/asr/tasks';
import { blockServiceTasks, restoreServiceTasks } from './services';
import { TaskStorage } from './storage';

type NewTask = Pick<
  AsrTask,
  'meetingId' | 'projectId' | 'recordingId' | 'title' | 'source' | 'serviceId'
> &
  Partial<
    Pick<
      AsrTask,
      | 'id'
      | 'denoise'
      | 'start'
      | 'end'
      | 'inputFile'
      | 'replace'
      | 'recordingOffset'
      | 'rangeStart'
      | 'rangeEnd'
      | 'deferred'
    >
  >;
export interface TaskClaim {
  task: AsrTask;
  chunk: AsrChunk;
}

export class AsrRepository extends TaskStorage {
  constructor(
    db: DatabaseSync,
    private now = Date.now
  ) {
    super(db);
  }

  create(input: NewTask): AsrTask {
    const now = this.now();
    const task: AsrTask = {
      id: randomUUID(),
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: 0,
      attempts: 0,
      failures: 0,
      generation: 0,
      deleted: false,
      sealed: false,
      deferred: false,
      reviewRequired: false,
      unpersistedRanges: [],
      stage: 'capture',
      denoise: false,
      recordingOffset: 0,
      rangeStart: 0,
      start: 0,
      end: 0,
      totalChunks: 0,
      completedChunks: 0,
      completedSeconds: 0,
      replace: false,
      ...input,
    };
    if (this.task(task.id)) throw new Error('辨識任務已存在');
    const health = this.health(task.serviceId);
    if (!task.deferred && health.error) {
      task.state = health.error.scope === 'none' ? 'needs_attention' : 'waiting_retry';
      task.error = health.error;
      task.nextAttemptAt = Math.max(health.nextAttemptAt, health.notBefore);
    }
    this.saveTask(task);
    return task;
  }

  list(filter: TaskFilter = {}): TaskPage {
    const clauses = ['deleted=0'];
    const args: SQLInputValue[] = [];
    for (const [column, value] of [
      ['project_id', filter.projectId],
      ['meeting_id', filter.meetingId],
      ['source', filter.source],
      ['state', filter.state],
    ]) {
      if (value) {
        clauses.push(`${column}=?`);
        args.push(value);
      }
    }
    const where = clauses.join(' AND ');
    const limit = Math.max(1, Math.min(50, Math.floor(filter.limit || 20)));
    const offset = Math.max(0, Math.floor(filter.offset || 0));
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS count FROM asr_tasks WHERE ${where}`).get(...args)
        ?.count || 0
    );
    const active = Number(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM asr_tasks
      WHERE deleted=0 AND state NOT IN ('completed','cancelled')`)
        .get()?.count || 0
    );
    const items = this.db
      .prepare(
        `SELECT data FROM asr_tasks WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset)
      .map((row) => taskSchema.parse(JSON.parse(String(row.data))));
    return {
      items,
      total,
      active,
      offset,
      nextOffset: offset + items.length < total ? offset + items.length : null,
      backgroundPaused: this.control('background-paused'),
    };
  }

  append(chunk: AsrChunk, generation: number): boolean {
    return this.transaction(() => {
      const task = this.task(chunk.taskId);
      if (
        !task ||
        task.deleted ||
        task.generation !== generation ||
        ['cancelled', 'completed'].includes(task.state)
      )
        return false;
      if (this.chunk(chunk.id)) return true;
      this.saveChunk(chunk);
      task.totalChunks++;
      task.end = Math.max(task.end, chunk.end);
      task.updatedAt = this.now();
      this.saveTask(task);
      return true;
    });
  }

  seal(id: string, generation: number): void {
    const task = this.task(id);
    if (!task || task.deleted || task.generation !== generation) return;
    task.sealed = true;
    task.stage = 'transcribe';
    if (task.completedChunks === task.totalChunks && isTaskActive(task)) task.state = 'completed';
    if (task.unpersistedRanges.length && !['paused', 'cancelled'].includes(task.state))
      task.state = 'needs_attention';
    task.updatedAt = this.now();
    this.saveTask(task);
  }

  claim(excludedServices: string[] = []): TaskClaim | undefined {
    return this.transaction(() => {
      const args: SQLInputValue[] = [this.now(), this.now(), this.now()];
      const clauses = [
        `t.deleted=0 AND t.state IN ('queued','waiting_retry') AND t.next_at<=? AND COALESCE(json_extract(t.data,'$.deferred'),0)=0`,
        `(json_extract(t.data,'$.replace')=0 OR json_extract(t.data,'$.sealed')=1)`,
        `EXISTS (SELECT 1 FROM asr_chunks c WHERE c.task_id=t.id AND c.state='queued')`,
        `NOT EXISTS (SELECT 1 FROM asr_tasks busy WHERE busy.service_id=t.service_id AND busy.state='running' AND busy.deleted=0)`,
        `NOT EXISTS (SELECT 1 FROM asr_services s WHERE s.id=t.service_id AND (
          json_extract(s.data,'$.nextAttemptAt')>? OR json_extract(s.data,'$.notBefore')>?
          OR json_extract(s.data,'$.error.scope')='none'))`,
      ];
      if (this.control('background-paused'))
        clauses.push(`t.source='live' AND json_extract(t.data,'$.sealed')=0`);
      for (const service of excludedServices) {
        clauses.push('t.service_id<>?');
        args.push(service);
      }
      const candidates = this.db
        .prepare(`SELECT t.data FROM asr_tasks t WHERE ${clauses.join(' AND ')}
        ORDER BY CASE t.source WHEN 'live' THEN 0 ELSE 1 END,t.updated_at,t.id LIMIT 1`)
        .all(...args);
      for (const row of candidates) {
        const task = taskSchema.parse(JSON.parse(String(row.data)));
        if (excludedServices.includes(task.serviceId)) continue;
        if ((task.source !== 'live' || task.sealed) && this.control('background-paused')) continue;
        const health = this.health(task.serviceId);
        if (Math.max(health.nextAttemptAt, health.notBefore) > this.now()) continue;
        const next = this.db
          .prepare(
            `SELECT data FROM asr_chunks WHERE task_id=? AND state='queued' ORDER BY sequence LIMIT 1`
          )
          .get(task.id);
        if (!next) continue;
        const chunk = chunkSchema.parse(JSON.parse(String(next.data)));
        task.state = 'running';
        task.attempts++;
        task.updatedAt = this.now();
        chunk.state = 'running';
        chunk.attempts++;
        chunk.generation = task.generation;
        chunk.lease = randomUUID();
        this.saveTask(task);
        this.saveChunk(chunk);
        return { task, chunk };
      }
      return undefined;
    });
  }

  valid(claim: TaskClaim): boolean {
    const task = this.task(claim.task.id);
    const chunk = this.chunk(claim.chunk.id);
    return (
      !!task &&
      !task.deleted &&
      task.state === 'running' &&
      !((task.source !== 'live' || task.sealed) && this.control('background-paused')) &&
      task.generation === claim.task.generation &&
      chunk?.state === 'running' &&
      chunk.lease === claim.chunk.lease
    );
  }

  complete(
    claim: TaskClaim,
    text: string,
    apply: (task: AsrTask, chunk: AsrChunk, text: string) => void,
    healthy = true
  ): boolean {
    return this.transaction(() => {
      if (!this.valid(claim)) return false;
      const task = this.task(claim.task.id);
      const chunk = this.chunk(claim.chunk.id);
      if (!task || !chunk) return false;
      apply(task, chunk, text);
      chunk.state = 'completed';
      chunk.result = text;
      chunk.lease = '';
      task.completedChunks++;
      const previous = chunk.index > 0 ? this.chunkAt(task.id, chunk.index - 1) : undefined;
      const coveredEnd = previous?.state === 'completed' ? previous.end : chunk.start;
      task.completedSeconds += Math.max(0, chunk.end - Math.max(chunk.start, coveredEnd));
      task.state =
        task.sealed && task.completedChunks === task.totalChunks ? 'completed' : 'queued';
      if (task.unpersistedRanges.length && task.state === 'completed')
        task.state = 'needs_attention';
      task.error = undefined;
      task.failures = 0;
      task.nextAttemptAt = 0;
      task.updatedAt = this.now();
      this.saveChunk(chunk);
      this.saveTask(task);
      if (healthy) {
        this.saveHealth({ id: task.serviceId, failures: 0, nextAttemptAt: 0, notBefore: 0 });
        restoreServiceTasks(this, task.serviceId, this.now());
      }
      return true;
    });
  }

  fail(claim: TaskClaim, error: FailureInfo, random?: number): boolean {
    return this.transaction(() => {
      if (!this.valid(claim)) return false;
      const task = this.task(claim.task.id);
      const chunk = this.chunk(claim.chunk.id);
      if (!task || !chunk) return false;
      const health = this.health(task.serviceId);
      if (error.scope === 'none' && error.kind === 'configuration') {
        health.error = error;
        this.saveHealth(health);
        blockServiceTasks(this, health);
      }
      if (error.scope === 'service') {
        health.failures++;
        health.notBefore = Math.max(health.notBefore, error.retryAt || 0);
        health.nextAttemptAt = Math.max(
          this.now() + retryDelay(health.failures, random),
          health.notBefore
        );
        health.error = error;
        this.saveHealth(health);
        blockServiceTasks(this, health);
      } else if (error.scope === 'chunk') {
        chunk.failures++;
        task.failures++;
      }
      chunk.state = 'queued';
      chunk.lease = '';
      task.error = error;
      task.updatedAt = this.now();
      task.state =
        error.scope === 'none' || chunk.failures >= 6 ? 'needs_attention' : 'waiting_retry';
      task.nextAttemptAt = Math.max(
        error.retryAt || 0,
        health.nextAttemptAt,
        this.now() + retryDelay(Math.max(1, chunk.failures), random)
      );
      this.saveChunk(chunk);
      this.saveTask(task);
      return true;
    });
  }

  act(ids: string[], action: TaskAction): void {
    this.transaction(() => {
      for (const id of ids) {
        const task = this.task(id);
        if (!task || task.deleted) continue;
        if (task.state === 'completed' && action !== 'delete') continue;
        if (task.state === 'cancelled' && action !== 'delete') continue;
        if (action === 'retry' && task.state === 'paused') continue;
        if (task.reviewRequired && ['retry', 'resume'].includes(action)) continue;
        task.generation++;
        task.updatedAt = this.now();
        if (action === 'pause') task.state = 'paused';
        else if (action === 'cancel' || action === 'delete') {
          task.state = 'cancelled';
          task.deleted = action === 'delete';
        } else {
          task.deferred = false;
          task.state = 'queued';
          const health = this.health(task.serviceId);
          if (action === 'retry') {
            health.nextAttemptAt = health.notBefore;
            health.error = undefined;
            this.saveHealth(health);
          }
          task.nextAttemptAt = Math.max(this.now(), health.notBefore, health.nextAttemptAt);
          task.error = health.error;
          if (health.error)
            task.state = health.error.scope === 'none' ? 'needs_attention' : 'waiting_retry';
        }
        this.saveTask(task);
        const rows = this.db
          .prepare(`SELECT data FROM asr_chunks WHERE task_id=? AND state<>'completed'`)
          .all(id);
        for (const row of rows) {
          const chunk = chunkSchema.parse(JSON.parse(String(row.data)));
          chunk.state = action === 'cancel' || action === 'delete' ? 'cancelled' : 'queued';
          chunk.generation = task.generation;
          chunk.lease = '';
          if (action === 'retry' || action === 'resume') chunk.failures = 0;
          this.saveChunk(chunk);
        }
      }
    });
  }

  pauseBackground(paused: boolean): void {
    this.transaction(() => {
      this.saveControl('background-paused', paused);
      if (!paused) return;
      for (const row of this.db
        .prepare(
          `SELECT data FROM asr_tasks WHERE (source<>'live' OR json_extract(data,'$.sealed')=1) AND state='running'`
        )
        .all()) {
        const task = taskSchema.parse(JSON.parse(String(row.data)));
        task.state = 'queued';
        task.generation++;
        this.saveTask(task);
        this.releaseChunks(task.id);
      }
    });
  }

  private releaseChunks(taskId: string): void {
    for (const row of this.db
      .prepare(`SELECT data FROM asr_chunks WHERE task_id=? AND state='running'`)
      .all(taskId)) {
      const chunk = chunkSchema.parse(JSON.parse(String(row.data)));
      chunk.state = 'queued';
      chunk.lease = '';
      this.saveChunk(chunk);
    }
  }

  release(claim: TaskClaim): void {
    const task = this.task(claim.task.id);
    const chunk = this.chunk(claim.chunk.id);
    if (
      !task ||
      !chunk ||
      task.state !== 'running' ||
      task.generation !== claim.task.generation ||
      chunk.lease !== claim.chunk.lease
    )
      return;
    task.state = 'queued';
    this.saveTask(task);
    this.releaseChunks(task.id);
  }

  autoRecovery(meetingId: string, enabled?: boolean): boolean {
    const key = `auto:${meetingId}`;
    if (enabled !== undefined) this.saveControl(key, enabled);
    return this.control(key, true);
  }

  recover(): void {
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT data FROM asr_tasks WHERE state='running'`).all();
      for (const row of rows) {
        const task = taskSchema.parse(JSON.parse(String(row.data)));
        task.state = 'queued';
        this.saveTask(task);
      }
      const chunks = this.db.prepare(`SELECT data FROM asr_chunks WHERE state='running'`).all();
      for (const row of chunks) {
        const chunk = chunkSchema.parse(JSON.parse(String(row.data)));
        chunk.state = 'queued';
        chunk.lease = '';
        this.saveChunk(chunk);
      }
    });
  }

  pendingBytes(): number {
    return Number(
      this.db
        .prepare(`SELECT COALESCE(SUM(c.bytes),0) AS bytes FROM asr_chunks c
      JOIN asr_tasks t ON t.id=c.task_id WHERE t.deleted=0 AND c.state NOT IN ('completed','cancelled')`)
        .get()?.bytes || 0
    );
  }

  nextDueAt(excludedServices: string[] = []): number | undefined {
    const args: SQLInputValue[] = [];
    const clauses = [
      `t.deleted=0 AND t.state IN ('queued','waiting_retry') AND COALESCE(json_extract(t.data,'$.deferred'),0)=0`,
      `(json_extract(t.data,'$.replace')=0 OR json_extract(t.data,'$.sealed')=1)`,
      `EXISTS (SELECT 1 FROM asr_chunks c WHERE c.task_id=t.id AND c.state='queued')`,
      `COALESCE(json_extract(s.data,'$.error.scope'),'')<>'none'`,
      `NOT EXISTS (SELECT 1 FROM asr_tasks busy WHERE busy.service_id=t.service_id AND busy.state='running' AND busy.deleted=0)`,
    ];
    if (this.control('background-paused'))
      clauses.push(`t.source='live' AND json_extract(t.data,'$.sealed')=0`);
    for (const service of excludedServices) {
      clauses.push('t.service_id<>?');
      args.push(service);
    }
    const row = this.db
      .prepare(`SELECT MIN(MAX(t.next_at,COALESCE(json_extract(s.data,'$.nextAttemptAt'),0),
      COALESCE(json_extract(s.data,'$.notBefore'),0))) AS due FROM asr_tasks t
      LEFT JOIN asr_services s ON s.id=t.service_id WHERE ${clauses.join(' AND ')}`)
      .get(...args);
    return typeof row?.due === 'number' ? row.due : undefined;
  }
}
