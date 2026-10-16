import type { AsrSettings } from './config';

export function realtimeRate(config: AsrSettings): number {
  if (config.provider === 'openai') {
    if (config.realtimeFlavor === 'vllm') {
      return 16000;
    }
    return 24000;
  }
  return Number(config.sampleRate || 24000);
}

export function validateRealtime(config: AsrSettings): URL {
  const url = new URL(config.url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password)
    throw new Error('即時辨識端點須為完整 ws:// 或 wss:// URL');
  if (!config.model?.trim()) throw new Error('請設定即時辨識模型');
  if (!['openai', 'vllm'].includes(config.realtimeFlavor || 'openai'))
    throw new Error('請選擇 OpenAI 或 vLLM Realtime 協定');
  const headers = config.headers || {};
  if (
    Array.isArray(headers) ||
    typeof headers !== 'object' ||
    Object.values(headers).some((value) => typeof value !== 'string')
  )
    throw new Error('即時驗證 Headers 需要字串值的 JSON 物件');
  if (
    url.hostname === 'api.openai.com' &&
    !config.apiKey?.trim() &&
    !new Headers(config.headers || {}).get('Authorization')
  )
    throw new Error('官方 OpenAI Realtime 需要 API key');
  return url;
}
