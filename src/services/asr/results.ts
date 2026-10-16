import type { AsrChunk, AsrTask } from '../../domain/asr/tasks';
import type { TranscriptSegment } from '../../domain/models';
import type { AsrRepository } from '../../persistence/asr/repository';
import type { Store } from '../../persistence/store';
import { trimOverlap } from '../../transport/transcription/file';

function segment(task: AsrTask, chunk: AsrChunk, text: string): TranscriptSegment {
  return {
    id: `asr:${task.id}:${chunk.id}`,
    recordingId: task.recordingId || undefined,
    text,
    start: chunk.start,
    end: chunk.end,
    final: true,
    speaker: task.source === 'live' ? '' : '會後補辨識',
    timing: 'approximate',
  };
}

/** Called inside the repository transaction. Replacements remain staged until every segment succeeds. */
export function applyTaskResult(
  store: Store,
  repository: AsrRepository,
  task: AsrTask,
  chunk: AsrChunk,
  raw: string
): void {
  const meeting = store.get('meetings', task.meetingId);
  if (!meeting) throw new Error('辨識任務的會議已不存在');
  if (task.replace) {
    if (!task.sealed || task.completedChunks + 1 < task.totalChunks) return;
    const replacements: TranscriptSegment[] = [];
    let previous = '';
    for (let offset = 0; ; offset += 50) {
      const chunks = repository.chunks(task.id, offset, 50);
      for (const item of chunks) {
        const result = item.id === chunk.id ? raw : item.result || '';
        const text = item.overlap ? trimOverlap(previous, result) : result.trim();
        if (text) replacements.push(segment(task, item, text));
        previous = result;
      }
      if (chunks.length < 50) break;
    }
    meeting.segments = meeting.segments.filter(
      (value) =>
        !(
          value.recordingId === task.recordingId &&
          value.start < task.end &&
          value.end > task.start
        )
    );
    meeting.segments.push(...replacements);
  } else {
    const previous =
      chunk.index > 0 ? repository.chunkAt(task.id, chunk.index - 1)?.result : undefined;
    const text = chunk.overlap && previous ? trimOverlap(previous, raw) : raw.trim();
    if (text) {
      const value = segment(task, chunk, text);
      const index = meeting.segments.findIndex((existing) => existing.id === value.id);
      if (index >= 0) meeting.segments[index] = value;
      else meeting.segments.push(value);
    }
  }
  meeting.segments.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  meeting.duration = Math.max(meeting.duration, chunk.end);
  const recording = meeting.recordings.find((value) => value.id === task.recordingId);
  if (recording)
    recording.duration = Math.max(recording.duration || 0, chunk.end - (recording.offset || 0));
  store.putMeeting(meeting);
}
