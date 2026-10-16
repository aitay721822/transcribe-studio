import { open, stat } from 'node:fs/promises';

export const FILE_SAMPLE_RATE = 16000;
export const FILE_CHUNK_SECONDS = 30;
export const BYTE_RATE = FILE_SAMPLE_RATE * 2;
export interface AudioChunk {
  start: number;
  end: number;
  overlap: number;
}

/** Prefer the middle of the latest >=200ms quiet interval in the last five seconds. */
function quietBoundary(pcm: Buffer): number {
  const frameBytes = FILE_SAMPLE_RATE * 0.02 * 2;
  let quietStart = -1;
  let boundary = 0;
  for (let offset = 25 * BYTE_RATE; offset < pcm.length; offset += frameBytes) {
    let power = 0;
    for (let i = offset; i < offset + frameBytes; i += 2)
      power += (pcm.readInt16LE(i) / 32768) ** 2;
    if (Math.sqrt(power / (frameBytes / 2)) < 0.006) {
      if (quietStart < 0) quietStart = offset;
      if (offset + frameBytes - quietStart >= 0.2 * BYTE_RATE)
        boundary = Math.floor((quietStart + offset + frameBytes) / 4) * 2;
    } else quietStart = -1;
  }
  return boundary;
}

export async function segmentAudio(
  file: string,
  signal: AbortSignal,
  progress: (seconds: number, total: number) => void
) {
  const size = (await stat(file)).size;
  if (!size || size % 2) throw new Error('音訊檔案沒有可辨識的音訊');
  const input = await open(file, 'r');
  const chunks: AudioChunk[] = [];
  let position = 0;
  let covered = 0;
  const buffer = Buffer.allocUnsafe(FILE_CHUNK_SECONDS * BYTE_RATE);
  try {
    while (position < size) {
      signal.throwIfAborted();
      const length = Math.min(buffer.length, size - position);
      let read = 0;
      while (read < length) {
        const result = await input.read(buffer, read, length - read, position + read);
        if (!result.bytesRead) throw new Error('音訊暫存檔讀取不完整');
        read += result.bytesRead;
      }
      const boundary = length === buffer.length ? quietBoundary(buffer) || length : length;
      const end = position + boundary;
      chunks.push({
        start: position / BYTE_RATE,
        end: end / BYTE_RATE,
        overlap: Math.max(0, covered - position) / BYTE_RATE,
      });
      covered = end;
      progress(end / BYTE_RATE, size / BYTE_RATE);
      if (end === size) break;
      position += boundary - (boundary === buffer.length ? BYTE_RATE : 0);
    }
  } finally {
    await input.close();
  }
  return { chunks, duration: size / BYTE_RATE };
}
