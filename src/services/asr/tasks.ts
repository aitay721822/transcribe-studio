import type { AsrEvent, AsrSettings } from '../../domain/asr/config';
import { realtimeRate } from '../../domain/asr/realtime';
import type { AsrChunk, AsrTask, TaskAction } from '../../domain/asr/tasks';
import { completeCovered } from '../../persistence/asr/coverage';
import type { Store } from '../../persistence/store';
import { DurableLiveSession } from './live';
import { AudioPreparation } from './preparation';
import { TranscriptionQueue } from './queue';
import { RecoveringRealtimeSession } from './realtime/session';
import { applyTaskResult } from './results';
import { transcriptionServiceId } from './service';
import { AudioSpool } from './spool';

interface TaskServiceOptions {
  store: Store;
  directory: string;
  settings(): AsrSettings;
  changed(meetingId?: string, task?: AsrTask): void;
}

export class AsrTaskService {
  readonly repository;
  readonly spool: AudioSpool;
  readonly queue: TranscriptionQueue;
  readonly preparation: AudioPreparation;
  private closing = false;
  private captures = new Set<DurableLiveSession>();
  private deleting = new Set<string>();

  constructor(private options: TaskServiceOptions) {
    this.repository = options.store.transcriptions;
    this.spool = new AudioSpool(options.directory);
    this.queue = new TranscriptionQueue({
      repository: this.repository,
      spool: this.spool,
      settings: options.settings,

      apply: (task, chunk, text) => this.apply(task, chunk, text),

      changed: (id) => this.changed(id),
    });
    this.preparation = new AudioPreparation({
      repository: this.repository,
      spool: this.spool,

      changed: (id) => this.changed(id),

      wake: () => this.queue.wake(),
    });
  }

  private changed(id: string): void {
    const task = this.repository.task(id);
    if (task?.source === 'import' && task.end > 0) {
      const meeting = this.options.store.get('meetings', task.meetingId);
      const recording = meeting?.recordings.find((value) => value.id === task.recordingId);
      if (meeting && recording) {
        recording.duration = Math.max(recording.duration || 0, task.end - (recording.offset || 0));
        meeting.duration = Math.max(meeting.duration, task.end);
        this.options.store.putMeeting(meeting);
      }
    }
    this.options.changed(task?.meetingId, task);
    if (!this.closing) this.resumePreparations();
  }

  private apply(task: AsrTask, chunk: AsrChunk, raw: string): void {
    applyTaskResult(this.options.store, this.repository, task, chunk, raw);
  }

  async start(): Promise<void> {
    let after = '';
    while (true) {
      const rows = this.repository.db
        .prepare(
          "SELECT id FROM asr_tasks WHERE id>? AND (deleted=1 OR state IN ('completed','cancelled')) ORDER BY id LIMIT 50"
        )
        .all(after);
      if (!rows.length) break;
      for (const row of rows) {
        after = String(row.id);
        await this.spool.removeTask(after);
      }
    }
    await this.spool.cleanOrphans(
      (file) =>
        !!this.repository.db
          .prepare(
            "SELECT 1 FROM asr_chunks WHERE state NOT IN ('completed','cancelled') AND json_extract(data,'$.path')=? LIMIT 1"
          )
          .get(file)
    );
    for await (const chunk of this.spool.manifests((id) => {
      const task = this.repository.task(id);
      if (!task || task.deleted || task.state === 'cancelled') return;
      if (task.state !== 'paused') task.state = 'needs_attention';
      task.reviewRequired = true;
      task.error = {
        kind: 'audio',
        scope: 'none',
        message: '音訊分段紀錄損壞，請由原始錄音重新選擇補辨識範圍',
      };
      this.repository.saveTask(task);
    })) {
      const task = this.repository.task(chunk.taskId);
      const saved = this.repository.chunk(chunk.id);
      if (!task || task.deleted || task.state === 'cancelled' || saved?.state === 'completed') {
        await this.spool.removeChunk(chunk);
        continue;
      }
      this.repository.append(chunk, task.generation);
      if (task.source === 'recovery') {
        const covered = completeCovered(this.repository, chunk.id);
        if (covered) await this.spool.removeChunk(covered);
      }
    }
    const captures = this.repository.db
      .prepare(`SELECT id FROM asr_tasks WHERE deleted=0
      AND json_extract(data,'$.sealed')=0 AND json_extract(data,'$.inputFile') IS NULL`)
      .all();
    for (const row of captures) {
      const task = this.repository.task(String(row.id));
      if (task) {
        task.deferred = false;
        if (task.reviewRequired && task.state !== 'paused' && task.state !== 'cancelled') {
          task.state = 'needs_attention';
          task.error = {
            kind: 'audio',
            scope: 'none',
            message: '上次即時辨識的音訊範圍需要核對，備援音訊已保留',
          };
        }
        this.repository.saveTask(task);
        this.repository.seal(task.id, task.generation);
      }
    }
    this.resumePreparations();
    this.queue.start();
  }

  private resumePreparations(): void {
    if (
      this.closing ||
      this.repository.control('background-paused') ||
      !this.preparation.hasCapacity()
    )
      return;
    let after = '';
    while (this.preparation.hasCapacity()) {
      const rows = this.repository.db
        .prepare(`SELECT id FROM asr_tasks WHERE deleted=0 AND id>?
        AND state IN ('queued','waiting_retry') AND json_extract(data,'$.sealed')=0
        AND json_extract(data,'$.inputFile') IS NOT NULL ORDER BY id LIMIT 20`)
        .all(after);
      if (!rows.length) return;
      for (const row of rows) {
        after = String(row.id);
        this.preparation.start(after);
        if (!this.preparation.hasCapacity()) return;
      }
    }
  }

  createFile(input: {
    meetingId: string;
    recordingId: string;
    file: string;
    source: 'import' | 'recording';
    denoise?: boolean;
    start?: number;
    end?: number;
    replace?: boolean;
  }): AsrTask {
    const meeting = this.options.store.get('meetings', input.meetingId);
    if (!meeting) throw new Error('找不到會議');
    if (this.deleting.has(meeting.id)) throw new Error('此會議正在刪除中');
    const recording = meeting.recordings.find((item) => item.id === input.recordingId);
    const rangeStart = input.start ?? 0;
    if (
      !Number.isFinite(rangeStart) ||
      rangeStart < 0 ||
      (input.end !== undefined && (!Number.isFinite(input.end) || input.end <= rangeStart)) ||
      (recording?.duration &&
        (rangeStart >= recording.duration ||
          (input.end !== undefined && input.end > recording.duration)))
    )
      throw new Error('請選擇錄音內有效的辨識時間範圍');
    const offset = recording?.offset || 0;
    const task = this.repository.create({
      meetingId: meeting.id,
      projectId: meeting.projectId,
      recordingId: input.recordingId,
      title: meeting.title,
      source: input.source,
      serviceId: transcriptionServiceId(this.options.settings()),
      inputFile: input.file,
      denoise: input.denoise !== false,
      replace: input.replace === true,
      recordingOffset: offset,
      rangeStart: input.start || 0,
      rangeEnd: input.end,
      start: offset + (input.start || 0),
      end: offset + (input.end || recording?.duration || 0),
    });
    task.stage = 'decode';
    this.repository.saveTask(task);
    this.changed(task.id);
    return task;
  }

  createLive(input: {
    meetingId: string;
    recordingId: string;
    offset: number;
    config: AsrSettings;
    emit(event: AsrEvent): void;
    recovery?: boolean;
  }): DurableLiveSession {
    const meeting = this.options.store.get('meetings', input.meetingId);
    if (!meeting) throw new Error('找不到會議');
    if (this.deleting.has(meeting.id)) throw new Error('此會議正在刪除中');

    const create = (start: number) =>
      this.repository.create({
        meetingId: meeting.id,
        projectId: meeting.projectId,
        recordingId: input.recordingId,
        title: meeting.title,
        source: input.recovery ? 'recovery' : 'live',
        deferred: input.recovery === true,
        serviceId: transcriptionServiceId(input.config),
        recordingOffset: input.offset,
        start,
      });

    const session = new DurableLiveSession({
      repository: this.repository,
      spool: this.spool,
      config: input.config,
      captureOnly: input.recovery,
      task: create(input.offset),

      changed: (id) => this.changed(id),

      wake: () => this.queue.wake(),

      emit: input.emit,
      create,

      closed: () => this.captures.delete(session),
    });
    this.captures.add(session);
    return session;
  }

  createRealtime(input: {
    meetingId: string;
    recordingId: string;
    offset: number;
    emit(event: AsrEvent): void;
    status(value: import('../../domain/asr/connection').AsrConnectionStatus): void;
    rtc(epoch: number): void;
  }): RecoveringRealtimeSession {
    const rate = realtimeRate(this.options.settings());
    return new RecoveringRealtimeSession({
      ...input,
      repository: this.repository,
      spool: this.spool,
      settings: this.options.settings,

      capture: (offset) =>
        this.createLive({
          ...input,
          offset,
          recovery: true,
          config: { ...this.options.settings(), sampleRate: rate },
        }),
    });
  }

  async act(ids: string[], action: TaskAction): Promise<void> {
    this.queue.act(ids, action);
    if (action === 'cancel' || action === 'delete')
      for (const capture of this.captures) capture.discard(ids);
    this.preparation.cancel(ids);
    await Promise.all([this.queue.settle(ids), this.preparation.settle(ids)]);
    for (const id of ids) {
      const task = this.repository.task(id);
      if (!task) continue;
      if (action === 'cancel' || action === 'delete') await this.spool.removeTask(id);
      else if (action === 'resume' || action === 'retry') this.preparation.start(id);
    }
    this.options.changed();
    this.queue.wake();
  }

  async pauseBackground(paused: boolean): Promise<void> {
    const ids = this.preparation.activeIds();
    this.queue.pauseBackground(paused);
    if (paused) {
      this.preparation.cancel(ids);
      await this.preparation.settle(ids);
    } else this.resumePreparations();
    this.options.changed();
  }

  async reassign(ids: string[]): Promise<void> {
    const eligible = ids.filter((id) => {
      const task = this.repository.task(id);
      return task && !task.deleted && !['completed', 'cancelled'].includes(task.state);
    });
    await this.act(eligible, 'pause');
    const serviceId = transcriptionServiceId(this.options.settings());
    for (const id of eligible) {
      const task = this.repository.task(id);
      if (!task) continue;
      task.serviceId = serviceId;
      this.repository.saveTask(task);
    }
    await this.act(eligible, 'resume');
    await this.act(eligible, 'retry');
  }

  async prepareDeletion(meetingId: string): Promise<void> {
    this.deleting.add(meetingId);
    let after = '';
    while (true) {
      const rows = this.repository.db
        .prepare('SELECT id FROM asr_tasks WHERE meeting_id=? AND id>? ORDER BY id LIMIT 100')
        .all(meetingId, after);
      if (!rows.length) return;
      const ids = rows.map((row) => String(row.id));
      after = ids[ids.length - 1];
      await this.act(ids, 'delete');
    }
  }

  endDeletion(meetingId: string): void {
    this.deleting.delete(meetingId);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([
      this.preparation.close(),
      this.queue.close(),
      ...[...this.captures].map((session) => session.close()),
    ]);
  }
}
