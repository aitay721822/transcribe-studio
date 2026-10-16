import { AsrFailure, failureInfo } from '../../domain/asr/retry';
import type { AsrChunk, AsrTask, TaskAction } from '../../domain/asr/tasks';
import { type TranscriptionConfig, validateTranscription } from '../../domain/transcription';
import { isCovered, partiallyCovered } from '../../persistence/asr/coverage';
import type { AsrRepository, TaskClaim } from '../../persistence/asr/repository';
import { expediteService } from '../../persistence/asr/services';
import { transcribeAudio } from '../../transport/transcription/request';
import { transcriptionServiceId } from './service';
import type { AudioSpool } from './spool';

export interface QueueOptions {
  repository: AsrRepository;
  spool: AudioSpool;
  settings(): TranscriptionConfig;
  apply(task: AsrTask, chunk: AsrChunk, text: string): void;
  changed(taskId: string): void;
  request?: typeof transcribeAudio;
  random?: () => number;
  intervalMs?: number;
  now?: () => number;
}

interface ActiveJob {
  claim: TaskClaim;
  controller: AbortController;
  done: Promise<void>;
}

/** One in-flight request per service, persisted deadlines, and a cancellation fence before commit. */
export class TranscriptionQueue {
  private active = new Map<string, ActiveJob>();
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private started = false;
  private lastProbe = 0;

  constructor(private options: QueueOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.wake();
  }

  wake(): void {
    if (!this.started || this.closing) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), 0);
    this.timer.unref?.();
  }

  networkRestored(): void {
    const now = (this.options.now || Date.now)();
    if (now - this.lastProbe < 1000) return;
    this.lastProbe = now;
    expediteService(this.options.repository, transcriptionServiceId(this.options.settings()), now);
    this.options.changed('');
    this.wake();
  }

  private pump(): void {
    if (this.closing) return;
    const { repository } = this.options;
    for (const job of this.active.values()) {
      if (!repository.valid(job.claim)) job.controller.abort();
    }
    while (this.active.size < 4) {
      const claim = repository.claim([...this.active.keys()]);
      if (!claim) break;
      const controller = new AbortController();
      const done = this.execute(claim, controller.signal).finally(() => {
        this.active.delete(claim.task.serviceId);
        this.options.changed(claim.task.id);
        this.wake();
      });
      this.active.set(claim.task.serviceId, { claim, controller, done });
      this.options.changed(claim.task.id);
    }
    const next = repository.nextDueAt([...this.active.keys()]);
    if (next !== undefined) {
      const delay = Math.max(
        this.options.intervalMs || 250,
        Math.min(60000, next - (this.options.now || Date.now)())
      );
      this.timer = setTimeout(() => this.pump(), delay);
      this.timer.unref?.();
    }
  }

  private async execute(claim: TaskClaim, signal: AbortSignal): Promise<void> {
    const { repository, spool } = this.options;
    try {
      if (
        claim.task.source === 'recovery' &&
        isCovered(repository, claim.task.recordingId, claim.chunk.start, claim.chunk.end)
      ) {
        if (repository.complete(claim, '', () => {}, false)) await spool.removeChunk(claim.chunk);
        return;
      }
      const config = this.options.settings();
      if (
        claim.task.source === 'recovery' &&
        partiallyCovered(repository, claim.task.recordingId, claim.chunk.start, claim.chunk.end)
      ) {
        const task = repository.task(claim.task.id);
        if (task) {
          task.reviewRequired = true;
          repository.saveTask(task);
        }
        throw new AsrFailure({
          kind: 'audio',
          scope: 'none',
          message: '備援分段與已確認的即時逐字稿部分重疊，請從原始錄音選擇範圍後補辨識',
        });
      }
      const saved = await spool.result(claim.chunk);
      let text: string;
      if (saved && saved.generation === claim.task.generation) text = saved.text;
      else {
        try {
          validateTranscription(config);
        } catch {
          throw new AsrFailure({
            kind: 'configuration',
            scope: 'none',
            message: '請檢查離線辨識端點、模型與驗證設定，修正後在任務面板重試',
          });
        }
        if (transcriptionServiceId(config) !== claim.task.serviceId)
          throw new AsrFailure({
            kind: 'configuration',
            scope: 'none',
            message: '服務設定已變更，請在任務面板明確選擇改用目前服務',
          });
        const bytes = await spool.bytes(claim.chunk);
        signal.throwIfAborted();
        const timeout = claim.task.source === 'live' ? 30000 : 30 * 60 * 1000;
        text = await (this.options.request || transcribeAudio)(
          config,
          bytes,
          'segment.wav',
          signal,
          timeout
        );
      }
      if (signal.aborted || !repository.valid(claim)) return;
      await spool.saveResult(claim.chunk, text);
      if (signal.aborted || !repository.valid(claim)) return;
      if (repository.complete(claim, text, this.options.apply))
        await spool.removeChunk(claim.chunk);
    } catch (error) {
      if (!signal.aborted) repository.fail(claim, failureInfo(error), this.options.random?.());
    } finally {
      repository.release(claim);
    }
  }

  act(ids: string[], action: TaskAction): void {
    this.options.repository.act(ids, action);
    for (const job of this.active.values()) {
      if (ids.includes(job.claim.task.id) && !this.options.repository.valid(job.claim))
        job.controller.abort();
    }
    for (const id of ids) this.options.changed(id);
    this.wake();
  }

  pauseBackground(paused: boolean): void {
    this.options.repository.pauseBackground(paused);
    if (paused) {
      for (const job of this.active.values()) {
        const task = this.options.repository.task(job.claim.task.id);
        if (task && (task.source !== 'live' || task.sealed)) job.controller.abort();
      }
    }
    this.options.changed('');
    this.wake();
  }

  async settle(ids: string[]): Promise<void> {
    await Promise.allSettled(
      [...this.active.values()]
        .filter((job) => ids.includes(job.claim.task.id))
        .map((job) => job.done)
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    const jobs = [...this.active.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.done));
  }
}
