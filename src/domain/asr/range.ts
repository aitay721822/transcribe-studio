import type { TranscriptSegment } from '../models';

export function replacementRange(
  segments: TranscriptSegment[],
  recordingId: string,
  offset: number,
  start: number,
  end: number
) {
  let left = start + offset;
  let right = end + offset;
  let changed = true;
  while (changed) {
    changed = false;
    for (const segment of segments) {
      if (segment.recordingId !== recordingId || segment.end <= left || segment.start >= right)
        continue;
      const nextLeft = Math.min(left, segment.start);
      const nextRight = Math.max(right, segment.end);
      if (nextLeft !== left || nextRight !== right) changed = true;
      left = nextLeft;
      right = nextRight;
    }
  }
  return {
    start: Math.max(0, left - offset),
    end: right - offset,
    segments: segments.filter(
      (segment) =>
        segment.recordingId === recordingId && segment.start < right && segment.end > left
    ),
  };
}
