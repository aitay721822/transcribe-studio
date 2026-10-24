import type { Settings } from '../../domain/models';
import { errorMessage, record } from '../../domain/value';
import { credentialRedactor } from '../security/redaction';

/** Draft tests reuse masked stored secrets without saving or revealing them. */
export function connectionSettings(draft: Partial<Settings>, saved: Settings): Settings {
  if (!draft || typeof draft !== 'object') throw new Error('測試設定無效');
  const settings: Settings = {
    ...saved,
    llm: { ...saved.llm, ...draft.llm },
    asr: { ...saved.asr, ...draft.asr, mapping: { ...saved.asr.mapping, ...draft.asr?.mapping } },
    mcp: [],
  };
  for (const key of ['llm', 'asr'] as const) {
    if (settings[key].apiKey === '••••••••') settings[key].apiKey = saved[key].apiKey;
    if (typeof settings[key].apiKey !== 'string') throw new Error('API key 無效');
  }
  if (settings.asr.fileApiKey === '••••••••') settings.asr.fileApiKey = saved.asr.fileApiKey;
  if (settings.llm.claudeKey === '••••••••') settings.llm.claudeKey = saved.llm.claudeKey;
  if (settings.llm.backend === 'responses') settings.llm.backend = 'openai';
  if (
    !['openai', 'codex', 'claude'].includes(settings.llm.backend || 'openai') ||
    !['openai', 'transcriptions', 'websocket', 'webrtc'].includes(settings.asr.provider)
  )
    throw new Error('測試服務類型無效');
  if (![16000, 24000, 48000].includes(Number(settings.asr.sampleRate)))
    throw new Error('取樣率無效');
  if (
    !settings.asr.headers ||
    Array.isArray(settings.asr.headers) ||
    typeof settings.asr.headers !== 'object' ||
    Object.values(settings.asr.headers).some((value) => typeof value !== 'string')
  )
    throw new Error('ASR headers 需要字串值的 JSON 物件');
  if (!Array.isArray(settings.asr.iceServers)) throw new Error('ICE servers 需要 JSON 陣列');
  return settings;
}

export function diagnosticError(
  error: unknown,
  settings: Settings,
  platform: NodeJS.Platform = process.platform
): string {
  const details: string[] = [],
    pending: unknown[] = [error],
    seen = new Set<unknown>();
  // Node fetch stores socket failures in cause, sometimes inside an AggregateError.
  for (let i = 0; i < pending.length && i < 16; i++) {
    const current = pending[i];
    if (seen.has(current)) continue;
    seen.add(current);
    const item = record(current);
    const message = typeof item.message === 'string' ? item.message : errorMessage(current);
    const code = typeof item.code === 'string' ? item.code : '';
    const detail = code ? `${code}: ${message}` : message;
    if (detail && !details.includes(detail)) details.push(detail);
    if (item.cause !== undefined) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors);
  }
  const message = credentialRedactor(settings).text(details.join('；')).slice(0, 1100);
  if (
    platform === 'darwin' &&
    /fetch failed|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|EPERM|EACCES|ERR_NETWORK_ACCESS_DENIED/i.test(
      message
    )
  )
    return `${message}\n若服務位於區域網路，請至 macOS「系統設定 → 隱私權與安全性 → 區域網路」允許 Transcribe Studio，然後重新開啟程式再測試。`;
  return message;
}
