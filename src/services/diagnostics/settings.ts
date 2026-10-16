import type { Settings } from '../../domain/models';

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

export function diagnosticError(error: unknown, settings: Settings): string {
  let message = String((error as Error)?.message || error).slice(0, 1500);
  const secrets = [
    settings.llm.apiKey,
    settings.llm.claudeKey,
    settings.asr.apiKey,
    settings.asr.fileApiKey,
    ...Object.values(settings.asr.headers || {}),
    ...Object.values(settings.asr.fileHeaders || {}),
  ];
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length > 3)
      message = message.replaceAll(secret, '••••••••');
  return message;
}
