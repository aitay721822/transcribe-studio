/** CLI diagnostics may include provider responses; remove inherited credentials before display. */
export function agentError(error: unknown, id: 'codex' | 'claude'): Error {
  let message = String((error as Error)?.message || error).slice(0, 2000);
  for (const key of [
    'OPENAI_API_KEY',
    'STUDIO_CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]) {
    const secret = process.env[key];
    if (secret && secret.length > 3) message = message.replaceAll(secret, '••••••••');
  }
  message = message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer ••••••••')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '••••••••');
  const login = id === 'codex' ? 'codex login' : 'claude auth login';
  if (/\b401\b|not.?logged.?in|authentication|token.*expired|invalid.*token/i.test(message))
    return new Error(
      `${id === 'codex' ? 'Codex' : 'Claude'} 登入失效或認證失敗，請執行 ${login} 後重試。`
    );
  if (/\b429\b|rate.?limit|usage.?limit|quota|credit.*balance|exceeded.*limit/i.test(message))
    return new Error('Agent 服務額度不足或請求受限，請確認帳戶額度或稍後重試。');
  if (/\b403\b|model.*(not.*(found|available)|access|permission)/i.test(message))
    return new Error('目前帳戶無法使用所選模型，請更換模型或確認帳戶權限。');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|connection error/i.test(message))
    return new Error('無法連線至 Agent 服務，請確認網路、代理或 CLI 服務設定。');
  return new Error(message);
}
