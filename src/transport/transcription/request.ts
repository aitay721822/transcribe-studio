import path from 'node:path';
import {
  type TranscriptionConfig,
  validateAudioFileSize,
  validateTranscription,
} from '../../domain/transcription';

const types: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
};

export function audioContentType(filename: string): string {
  return types[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

export async function transcribeAudio(
  config: TranscriptionConfig,
  audio: Uint8Array | Blob,
  filename: string,
  signal?: AbortSignal,
  timeout = 180000
): Promise<string> {
  signal?.throwIfAborted();
  const { url } = validateTranscription(config);
  validateAudioFileSize(audio instanceof Blob ? audio.size : audio.byteLength);
  const headers = new Headers();
  const key = (config.fileApiKey ?? config.apiKey)?.trim();
  if (key) headers.set('Authorization', `Bearer ${key}`);
  for (const [key, value] of Object.entries(config.fileHeaders || {})) headers.set(key, value);
  const form = new FormData();
  form.append(
    'file',
    audio instanceof Blob
      ? audio
      : new Blob([new Uint8Array(audio)], { type: audioContentType(filename) }),
    path.basename(filename)
  );
  form.append('model', config.fileModel.trim());
  form.append('response_format', 'json');
  if (config.language?.trim()) form.append('language', config.language.trim());
  // Cancellation may arrive while this segment is being queued, before fetch opens the body stream.
  await Promise.resolve();
  signal?.throwIfAborted();
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    // Provider responses may contain credentials; return a useful, bounded status without the raw body.
    await response.body?.cancel();
    throw new Error(`HTTP 轉錄失敗 (${response.status})，請確認端點、驗證與模型`);
  }
  const payload = await response.json();
  if (typeof payload.text !== 'string') throw new Error('HTTP 轉錄回應須包含 JSON text 字串');
  return payload.text;
}
