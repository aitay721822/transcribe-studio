import type { AsrEvent, SpeechSession } from '../../domain/asr/config';
import { failureInfo } from '../../domain/asr/retry';
import type { AsrTask } from '../../domain/asr/tasks';
import { type TranscriptionConfig, validateTranscription } from '../../domain/transcription';
import { completeCovered } from '../../persistence/asr/coverage';
import type { AsrRepository } from '../../persistence/asr/repository';
import { SpeechBoundary } from '../../transport/transcription/boundary';
import { pcmWav } from '../../transport/transcription/wav';
import type { AudioSpool } from './spool';

interface LiveOptions {
  repository: AsrRepository;
  spool: AudioSpool;
  config: TranscriptionConfig;
  task: AsrTask;
  changed(id: string): void;
  wake(): void;
  emit(event: AsrEvent): void;
  create(start: number): AsrTask;
  closed?(): void;
  captureOnly?: boolean;
}

/** Capture commits independently decodable files; inference never blocks the recording IPC. */
export class DurableLiveSession implements SpeechSession {
  private task: AsrTask;
  private rate = 24000;
  private limit = 0;
  private parts: Buffer[] = [];
  private length = 0;
  private consumed = 0;
  private index = 0;
  private pending = 0;
  private writes: Promise<void> = Promise.resolve();
  private ready = false;
  private closing?: Promise<void>;
  private lastWarning = '';
  private deferred: boolean;
  private boundary?: SpeechBoundary;

  constructor(private options: LiveOptions) {
    this.task = options.task;
    this.deferred = options.task.deferred;
  }

  async connect(): Promise<void> {
    const seconds = this.options.captureOnly
      ? 5
      : validateTranscription(this.options.config).seconds;
    this.rate = Number(this.options.config.sampleRate || 24000);
    if (![16000, 24000, 48000].includes(this.rate)) throw new Error('HTTP 音訊取樣率無效');
    this.limit = Math.round(this.rate * seconds) * 2;
    if (!this.options.captureOnly) this.boundary = new SpeechBoundary(this.rate);
    this.ready = true;
  }

  position(): number {
    return this.task.recordingOffset + (this.consumed + this.length) / (this.rate * 2);
  }

  async activate(): Promise<void> {
    this.commit();
    this.deferred = false;
    const id = this.task.id;
    this.writes = this.writes.then(() => {
      const task = this.options.repository.task(id);
      if (!task || task.deleted || ['cancelled', 'completed'].includes(task.state)) return;
      task.deferred = false;
      const health = this.options.repository.health(task.serviceId);
      if (health.error && task.state !== 'paused') {
        task.error = health.error;
        task.state = health.error.scope === 'none' ? 'needs_attention' : 'waiting_retry';
        task.nextAttemptAt = Math.max(health.nextAttemptAt, health.notBefore);
      }
      if (
        task.reviewRequired &&
        task.completedChunks < task.totalChunks &&
        task.state !== 'paused'
      ) {
        task.state = 'needs_attention';
        task.error = {
          kind: 'audio',
          scope: 'none',
          message:
            '即時服務未提供可核對的音訊範圍；備援音訊已保留，請選擇範圍補辨識，避免重複逐字稿',
        };
      }
      this.options.repository.saveTask(task);
      this.options.changed(task.id);
      this.options.wake();
    });
    await this.writes;
  }

  async rotate(deferred: boolean): Promise<void> {
    this.commit();
    const start = this.position();
    const previousId = this.task.id;
    this.deferred = deferred;
    if (this.options.repository.autoRecovery(this.task.meetingId)) {
      this.task = this.options.create(start);
      this.task.deferred = deferred;
      this.options.repository.saveTask(this.task);
      this.index = 0;
    }
    this.writes = this.writes.then(() => {
      const previous = this.options.repository.task(previousId);
      if (previous) {
        previous.deferred = false;
        if (
          previous.reviewRequired &&
          previous.completedChunks < previous.totalChunks &&
          !['paused', 'cancelled'].includes(previous.state) &&
          !previous.deleted
        ) {
          previous.state = 'needs_attention';
          previous.error = {
            kind: 'audio',
            scope: 'none',
            message: '部分即時音訊無法確認辨識範圍，請人工核對後補辨識',
          };
        }
        this.options.repository.saveTask(previous);
        this.options.repository.seal(previous.id, previous.generation);
        this.options.changed(previous.id);
        this.options.wake();
      }
    });
    await this.writes;
  }

  requireReview(): void {
    const task = this.options.repository.task(this.task.id);
    if (!task || task.deleted || task.state === 'cancelled') return;
    task.reviewRequired = true;
    this.options.repository.saveTask(task);
  }

  discard(ids: string[]): void {
    if (!ids.includes(this.task.id)) return;
    this.consumed += this.length;
    this.parts = [];
    this.length = 0;
    this.boundary?.reset();
  }

  audio(input: ArrayBuffer): boolean {
    if (!this.ready) return false;
    const bytes = Buffer.from(input);
    if (bytes.length > 256000 || bytes.length % 2) throw new Error('PCM16 音訊片段無效');
    let offset = 0;
    while (offset < bytes.length) {
      const available = Math.min(this.limit - this.length, bytes.length - offset);
      const size = this.boundary?.consume(bytes.subarray(offset, offset + available)) ?? available;
      this.parts.push(Buffer.from(bytes.subarray(offset, offset + size)));
      this.length += size;
      offset += size;
      if (this.length === this.limit || this.boundary?.reached()) this.commit();
    }
    return true;
  }

  commit(): void {
    if (!this.length) return;
    const bytes = Buffer.concat(this.parts, this.length);
    const start = this.task.recordingOffset + this.consumed / (this.rate * 2);
    this.consumed += this.length;
    const end = this.task.recordingOffset + this.consumed / (this.rate * 2);
    this.parts = [];
    this.length = 0;
    this.boundary?.reset();
    let power = 0;
    for (let index = 0; index < bytes.length; index += 2)
      power += (bytes.readInt16LE(index) / 32768) ** 2;
    if (Math.sqrt(power / (bytes.length / 2)) < 0.006) return;
    const current = this.options.repository.task(this.task.id);
    if (!current || current.deleted || ['cancelled', 'completed'].includes(current.state)) {
      if (!this.options.repository.autoRecovery(this.task.meetingId)) return;
      this.task = this.options.create(start);
      this.task.deferred = this.deferred;
      this.options.repository.saveTask(this.task);
      this.index = 0;
    }
    const taskId = this.task.id;
    const index = this.index++;
    if (this.pending >= 4) {
      this.warn(
        '音訊暫存寫入速度不足，此範圍尚未加入辨識任務；本地錄音仍持續，請於會後補辨識',
        start,
        end
      );
      return;
    }
    this.pending++;
    this.writes = this.writes
      .then(async () => {
        const { repository, spool } = this.options;
        if (this.options.captureOnly && !repository.autoRecovery(this.task.meetingId)) return;
        const task = repository.task(taskId);
        if (!task || task.deleted || task.state === 'cancelled') return;
        if (!repository.autoRecovery(task.meetingId) && repository.health(task.serviceId).error)
          return;
        const wav = pcmWav(bytes, this.rate);
        await spool.capacity(repository.pendingBytes(), wav.length);
        const saved = await spool.put(task.id, index, start, end, wav, task.generation);
        if (!repository.append(saved, task.generation)) {
          await spool.removeChunk(saved);
          return;
        }
        const covered = completeCovered(repository, saved.id);
        if (covered) await spool.removeChunk(covered);
        this.options.changed(task.id);
        this.options.wake();
      })
      .catch((error: unknown) => {
        this.warn(failureInfo(error).message, start, end, taskId);
      })
      .finally(() => {
        this.pending--;
      });
  }

  private warn(message: string, start?: number, end?: number, taskId = this.task.id): void {
    const task = this.options.repository.task(taskId);
    if (
      task &&
      !task.deleted &&
      task.state !== 'cancelled' &&
      start !== undefined &&
      end !== undefined
    ) {
      const ranges = task.unpersistedRanges;
      const last = ranges.at(-1);
      if (last && last.end === start && last.message === message) last.end = end;
      else ranges.push({ start, end, message });
      task.end = Math.max(task.end, end);
      task.error = { kind: 'audio', scope: 'none', message };
      this.options.repository.saveTask(task);
      this.options.changed(task.id);
    }
    if (this.lastWarning === message) return;
    this.lastWarning = message;
    this.options.emit({ type: 'warning', message });
  }

  cancel(): void {
    void this.close();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ready = false;
    this.commit();
    this.closing = this.writes
      .then(() => {
        const task = this.options.repository.task(this.task.id);
        if (task) this.options.repository.seal(task.id, task.generation);
        this.options.changed(this.task.id);
        this.options.wake();
      })
      .finally(() => this.options.closed?.());
    return this.closing;
  }
}
