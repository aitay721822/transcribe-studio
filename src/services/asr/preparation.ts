import { failureInfo } from '../../domain/asr/retry';
import type { AsrTask } from '../../domain/asr/tasks';
import type { AsrRepository } from '../../persistence/asr/repository';
import { audioChunks, FILE_SAMPLE_RATE } from '../../transport/transcription/preprocess';
import { pcmWav } from '../../transport/transcription/wav';
import type { AudioSpool } from './spool';

interface PreparationOptions {
  repository: AsrRepository;
  spool: AudioSpool;
  changed(id: string): void;
  wake(): void;
}

/** Preparation is restartable from the managed original; committed segments are never regenerated. */
export class AudioPreparation {
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;

  constructor(private options: PreparationOptions) {}

  activeIds(): string[] {
    return [...this.active.keys()];
  }

  hasCapacity(): boolean {
    return this.active.size < 2;
  }

  start(id: string): void {
    const { repository } = this.options;
    const task = repository.task(id);
    if (
      this.closing ||
      !this.hasCapacity() ||
      this.active.has(id) ||
      !task?.inputFile ||
      task.deleted ||
      task.sealed ||
      !['queued', 'waiting_retry'].includes(task.state) ||
      repository.control('background-paused')
    )
      return;
    const controller = new AbortController();
    const done = this.prepare(task, controller.signal).finally(() => {
      this.active.delete(id);
      this.options.changed(id);
    });
    this.active.set(id, { controller, done });
  }

  private async prepare(task: AsrTask, signal: AbortSignal): Promise<void> {
    const { repository, spool } = this.options;
    if (!task.inputFile) return;
    let index = 0;
    let previousEnd = 0;
    try {
      for await (const chunk of audioChunks(task.inputFile, signal, {
        denoise: task.denoise,

        onProgress: (progress) => {
          const current = repository.task(task.id);
          if (
            !current ||
            current.generation !== task.generation ||
            current.deleted ||
            signal.aborted
          )
            return;
          if (['decode', 'denoise', 'segment'].includes(progress.stage)) {
            if (progress.totalSeconds !== undefined)
              current.end =
                current.recordingOffset +
                Math.min(current.rangeEnd ?? progress.totalSeconds, progress.totalSeconds);
            if (progress.stage === 'decode') current.stage = 'decode';
            if (progress.stage === 'denoise') current.stage = 'denoise';
            if (progress.stage === 'segment') current.stage = 'segment';
            current.updatedAt = Date.now();
            repository.saveTask(current);
            this.options.changed(task.id);
          }
        },
      })) {
        signal.throwIfAborted();
        const current = repository.task(task.id);
        if (
          !current ||
          current.generation !== task.generation ||
          current.deleted ||
          ['paused', 'cancelled'].includes(current.state) ||
          repository.control('background-paused')
        )
          return;
        const start = Math.max(chunk.start, task.rangeStart);
        const end = Math.min(chunk.end, task.rangeEnd ?? chunk.end);
        if (end <= start) continue;
        const sequence = index++;
        if (repository.chunkAt(task.id, sequence)) {
          previousEnd = end;
          continue;
        }
        const begin = Math.round((start - chunk.start) * FILE_SAMPLE_RATE) * 2;
        const finish = Math.round((end - chunk.start) * FILE_SAMPLE_RATE) * 2;
        const bytes = pcmWav(chunk.pcm.subarray(begin, finish), FILE_SAMPLE_RATE);
        await spool.capacity(repository.pendingBytes(), bytes.length);
        const saved = await spool.put(
          task.id,
          sequence,
          task.recordingOffset + start,
          task.recordingOffset + end,
          bytes,
          task.generation,
          start < previousEnd
        );
        if (!repository.append(saved, task.generation)) {
          await spool.removeChunk(saved);
          return;
        }
        previousEnd = end;
        this.options.changed(task.id);
        this.options.wake();
      }
      signal.throwIfAborted();
      if (!index) throw new Error('所選範圍沒有可辨識音訊');
      repository.seal(task.id, task.generation);
      this.options.wake();
    } catch (error) {
      if (signal.aborted) return;
      const current = repository.task(task.id);
      if (!current || current.generation !== task.generation || current.deleted) return;
      current.state = 'needs_attention';
      current.error = failureInfo(error);
      current.updatedAt = Date.now();
      repository.saveTask(current);
    }
  }

  cancel(ids: string[]): void {
    for (const id of ids) this.active.get(id)?.controller.abort();
  }

  async settle(ids: string[]): Promise<void> {
    await Promise.allSettled(
      ids.flatMap((id) => {
        const job = this.active.get(id);
        return job ? [job.done] : [];
      })
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const job of this.active.values()) job.controller.abort();
    await Promise.allSettled([...this.active.values()].map((job) => job.done));
  }
}
