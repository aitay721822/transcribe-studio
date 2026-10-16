import path from 'node:path';
import { AsrFailure, failureInfo, httpFailure, retryAfter } from '../../domain/asr/retry';
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

async function providerErrorCode(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= 16384) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) return '';
      parts.push(part.value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!payload || typeof payload !== 'object' || !('error' in payload)) return '';
    const error = payload.error;
    if (!error || typeof error !== 'object' || !('code' in error)) return '';
    return typeof error.code === 'string' ? error.code : '';
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => {});
  }
}

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
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw new AsrFailure(failureInfo(error), { cause: error });
  }
  if (!response.ok) {
    // Provider responses may contain credentials; return a useful, bounded status without the raw body.
    const deadline = retryAfter(response.headers.get('Retry-After'), Date.now());
    const code = await providerErrorCode(response);
    throw new AsrFailure(httpFailure(response.status, deadline, code));
  }
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('text' in payload) ||
    typeof payload.text !== 'string'
  )
    throw new Error('HTTP 轉錄回應須包含 JSON text 字串');
  return payload.text;
}
