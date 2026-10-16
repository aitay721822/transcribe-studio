import type { AsrChunk } from '../../domain/asr/tasks';
import { chunkSchema } from '../../domain/asr/tasks';
import type { TaskStorage } from './storage';

export function partiallyCovered(
  storage: TaskStorage,
  recordingId: string,
  start: number,
  end: number
): boolean {
  return (
    !!storage.db
      .prepare('SELECT 1 FROM asr_coverage WHERE recording_id=? AND start<? AND end>? LIMIT 1')
      .get(recordingId, end - 0.00001, start + 0.00001) &&
    !isCovered(storage, recordingId, start, end)
  );
}

export function isCovered(
  storage: TaskStorage,
  recordingId: string,
  start: number,
  end: number
): boolean {
  return !!storage.db
    .prepare('SELECT 1 FROM asr_coverage WHERE recording_id=? AND start<=? AND end>=? LIMIT 1')
    .get(recordingId, start + 0.00001, end - 0.00001);
}

/** Transcript and audio acknowledgement share one transaction; receipt time alone is never proof. */
export function acknowledge(
  storage: TaskStorage,
  recordingId: string,
  start: number,
  end: number,
  apply: () => void
): void {
  storage.transaction(() => {
    apply();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const overlaps = storage.db
      .prepare('SELECT start,end FROM asr_coverage WHERE recording_id=? AND start<=? AND end>=?')
      .all(recordingId, end, start);
    for (const row of overlaps) {
      start = Math.min(start, Number(row.start));
      end = Math.max(end, Number(row.end));
    }
    storage.db
      .prepare('DELETE FROM asr_coverage WHERE recording_id=? AND start<=? AND end>=?')
      .run(recordingId, end, start);
    storage.db.prepare('INSERT INTO asr_coverage VALUES (?,?,?)').run(recordingId, start, end);
  });
}

export function completeCovered(storage: TaskStorage, chunkId: string): AsrChunk | undefined {
  return storage.transaction(() => {
    const chunk = storage.chunk(chunkId);
    const task = chunk && storage.task(chunk.taskId);
    if (
      !chunk ||
      !task ||
      task.deleted ||
      ['cancelled', 'paused'].includes(task.state) ||
      chunk.state !== 'queued' ||
      !isCovered(storage, task.recordingId, chunk.start, chunk.end)
    )
      return undefined;
    chunk.state = 'completed';
    chunk.result = '';
    task.completedChunks++;
    task.completedSeconds += chunk.end - chunk.start;
    if (task.sealed && task.completedChunks === task.totalChunks) {
      task.state = task.unpersistedRanges.length ? 'needs_attention' : 'completed';
      if (task.state === 'completed') task.error = undefined;
    }
    storage.saveChunk(chunk);
    storage.saveTask(task);
    return chunk;
  });
}

export function coveredCandidates(
  storage: TaskStorage,
  recordingId: string,
  after = '',
  limit = 50
): AsrChunk[] {
  return storage.db
    .prepare(`SELECT c.data FROM asr_chunks c JOIN asr_tasks t ON t.id=c.task_id
    WHERE json_extract(t.data,'$.recordingId')=? AND c.id>? AND c.state='queued' AND t.deleted=0
    ORDER BY c.id LIMIT ?`)
    .all(recordingId, after, limit)
    .map((row) => chunkSchema.parse(JSON.parse(String(row.data))));
}
