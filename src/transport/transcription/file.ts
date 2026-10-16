import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileProgress } from '../../domain/asr/file-progress';
import {
  type TranscriptionConfig,
  validateAudioFileSize,
  validateTranscription,
} from '../../domain/transcription';
import { audioChunks, FILE_SAMPLE_RATE } from './preprocess';
import { transcribeAudio } from './request';
import { pcmWav } from './wav';

export interface FileOptions {
  signal?: AbortSignal;
  filename?: string;
  denoise?: boolean;
  onProgress?: (progress: FileProgress) => void;
  onSegment?: (segment: { text: string; start: number; end: number }) => void;
  onDuration?: (seconds: number) => void;
}

/** Remove only a substantial exact boundary match, ignoring punctuation and case. */
export function trimOverlap(previous: string, next: string): string {
  const normalize = (text: string) => {
    return [...text.matchAll(/[\p{L}\p{N}]/gu)].map((match) => ({
      value: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    }));
  };

  const original = previous.slice(-100);
  const left = normalize(original);
  const right = normalize(next.slice(0, 100));
  // One second of speech: keep the search short to avoid erasing later repeated sentences.
  for (let count = Math.min(24, left.length, right.length); count >= 4; count--) {
    const a = left
      .slice(-count)
      .map((char) => char.value)
      .join('');
    const b = right
      .slice(0, count)
      .map((char) => char.value)
      .join('');
    if (a !== b) continue;
    const end = right[count - 1].end;
    const prefix = next.slice(0, end);
    const han = prefix.match(/\p{Script=Han}/gu)?.length || 0;
    if (han < 4) {
      // Latin matches must contain at least two whole words on both sides.
      const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');

      if (prefix.match(/[\p{L}\p{N}]+/gu)?.length < 2) continue;
      if (/[\p{L}\p{N}]/u.test(next[end] || '')) continue;
      const start = left[left.length - count].start;
      if (/[\p{L}\p{N}]/u.test(original[start - 1] || '')) continue;
      if (words(original.slice(start)) !== words(prefix)) continue;
    }
    return next
      .slice(end)
      .replace(/^[\s，。！？；：、,.!?;:…]+/u, '')
      .trim();
  }
  return next.trim();
}

export async function transcribeFile(
  config: TranscriptionConfig,
  filePath: string,
  {
    signal,
    filename = path.basename(filePath),
    denoise = true,
    onProgress,
    onSegment,
    onDuration,
  }: FileOptions = {}
): Promise<string> {
  signal?.throwIfAborted();
  validateTranscription(config);
  validateAudioFileSize((await stat(filePath)).size);
  const parts: string[] = [];
  let previous = '';
  let index = 0;
  const name = path.basename(filename, path.extname(filename));
  for await (const chunk of audioChunks(filePath, signal, { denoise, onProgress })) {
    onProgress?.({
      stage: 'transcribe',
      percent: (index / chunk.totalChunks) * 100,
      chunk: index,
      totalChunks: chunk.totalChunks,
      totalSeconds: chunk.totalSeconds,
      denoise,
    });
    const text = await transcribeAudio(
      config,
      pcmWav(chunk.pcm, FILE_SAMPLE_RATE),
      `${name}-${String(++index).padStart(3, '0')}.wav`,
      signal,
      30 * 60 * 1000
    );
    signal?.throwIfAborted();
    const merged = chunk.overlap ? trimOverlap(previous, text) : text.trim();
    if (merged) {
      parts.push(merged);
      onSegment?.({ text: merged, start: chunk.start, end: chunk.end });
    }
    previous = text.trim();
    onDuration?.(chunk.end);
    onProgress?.({
      stage: 'transcribe',
      percent: (index / chunk.totalChunks) * 100,
      chunk: index,
      totalChunks: chunk.totalChunks,
      seconds: chunk.end,
      totalSeconds: chunk.totalSeconds,
      denoise,
    });
  }
  if (!index) throw new Error('音訊檔案沒有可辨識的音訊');
  if (!parts.length) throw new Error('沒有辨識到文字');
  onProgress?.({ stage: 'completed', percent: 100, denoise });
  return parts.join('\n');
}
