export const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const AUDIO_FILE_LIMIT = 1024 * 1024 * 1024;
export const AUDIO_FILE_LIMIT_LABEL = '1 GB';

export function validateAudioFileSize(size: number): void {
  if (size > AUDIO_FILE_LIMIT) throw new Error(`單檔音訊上限 ${AUDIO_FILE_LIMIT_LABEL}`);
}

export interface TranscriptionConfig {
  provider?: string;
  fileUrl?: string;
  fileModel?: string;
  apiKey?: string;
  fileApiKey?: string;
  language?: string;
  fileHeaders?: Record<string, string>;
  chunkSeconds?: number;
  sampleRate?: number;
}

export function transcriptionEndpoint(config: TranscriptionConfig): URL {
  const url = new URL(config.fileUrl ?? TRANSCRIPTION_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('轉錄端點須為完整 HTTP(S) URL，驗證資料請填 API key 或 Headers');
  return url;
}

export function validateTranscription(config: TranscriptionConfig) {
  const url = transcriptionEndpoint(config);
  if (!config.fileModel?.trim()) throw new Error('請設定 HTTP 轉錄模型');
  const headers = config.fileHeaders || {};
  if (
    Array.isArray(headers) ||
    typeof headers !== 'object' ||
    Object.values(headers).some((value) => typeof value !== 'string')
  )
    throw new Error('HTTP 轉錄 Headers 需要字串值的 JSON 物件');
  const auth = new Headers(headers);
  if (auth.has('Content-Type'))
    throw new Error('HTTP 轉錄 Headers 不可設定 Content-Type，會自動產生 multipart boundary');
  if (
    url.hostname === 'api.openai.com' &&
    !(config.fileApiKey ?? config.apiKey)?.trim() &&
    !auth.get('Authorization')
  )
    throw new Error('官方 OpenAI 轉錄服務需要 API key');
  const seconds = Number(config.chunkSeconds ?? 5);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 15)
    throw new Error('HTTP 分段秒數須介於 2 至 15 秒');
  return { url, seconds };
}
