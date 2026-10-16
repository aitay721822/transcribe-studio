export type FailureKind =
  | 'connection'
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'configuration'
  | 'audio'
  | 'unknown';

export interface FailureInfo {
  kind: FailureKind;
  message: string;
  scope: 'service' | 'chunk' | 'none';
  status?: number;
  retryAt?: number;
}

export class AsrFailure extends Error {
  constructor(
    readonly info: FailureInfo,
    options?: ErrorOptions
  ) {
    super(info.message, options);
    this.name = 'AsrFailure';
  }
}

export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : undefined;
  const deadline = seconds === undefined ? Date.parse(text) : now + seconds * 1000;
  if (!Number.isFinite(deadline) || deadline <= now || deadline > 8640000000000000)
    return undefined;
  return deadline;
}

export function retryDelay(failures: number, random = Math.random()): number {
  const steps = [2000, 5000, 10000, 20000, 40000, 60000];
  const base = steps[Math.min(steps.length - 1, Math.max(0, Math.floor(failures) - 1))];
  return Math.round(Math.min(60000, base * (0.8 + Math.max(0, Math.min(1, random)) * 0.4)));
}

function errorCode(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if ('code' in value && typeof value.code === 'string') return value.code;
  if ('cause' in value && value.cause !== value) return errorCode(value.cause);
  return '';
}

export function failureInfo(error: unknown): FailureInfo {
  if (error instanceof AsrFailure) return error.info;
  const code = errorCode(error);
  if (/^(?:CERT_|ERR_TLS_|DEPTH_ZERO_|UNABLE_TO_VERIFY_|SELF_SIGNED_)/.test(code))
    return { kind: 'configuration', scope: 'none', message: '服務憑證驗證失敗，請檢查端點與憑證' };
  if (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EPIPE',
    ].includes(code)
  )
    return {
      kind: 'connection',
      scope: 'service',
      message: '無法連線至辨識服務，音訊已保留並等待重試',
    };
  if (code === 'UND_ERR_CONNECT_TIMEOUT')
    return { kind: 'connection', scope: 'service', message: '辨識服務連線逾時，等待重試' };
  if (error instanceof Error && error.name === 'TimeoutError')
    return { kind: 'timeout', scope: 'chunk', message: '辨識回應逾時，分段已保留並等待重試' };
  if (['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code))
    return { kind: 'timeout', scope: 'chunk', message: '辨識回應逾時，分段已保留並等待重試' };
  return { kind: 'unknown', scope: 'chunk', message: '辨識工作未能完成，請檢查服務狀態或重新嘗試' };
}

export function httpFailure(status: number, retryAt?: number, providerCode = ''): FailureInfo {
  const message = `HTTP 轉錄失敗 (${status})，請確認端點、驗證與模型`;
  if (['insufficient_quota', 'billing_hard_limit_reached'].includes(providerCode))
    return {
      kind: 'configuration',
      scope: 'none',
      status,
      message: '辨識服務額度不足，請處理帳務或服務設定',
    };
  if (status === 429)
    return {
      kind: 'rate_limit',
      scope: 'service',
      status,
      retryAt,
      message: '辨識服務流量受限，等待服務允許後重試',
    };
  if ([500, 502, 503, 504].includes(status))
    return { kind: 'server', scope: 'service', status, retryAt, message };
  if (status === 408) return { kind: 'timeout', scope: 'chunk', status, retryAt, message };
  if ([413, 415, 422].includes(status)) return { kind: 'audio', scope: 'none', status, message };
  if (status >= 400 && status < 500)
    return { kind: 'configuration', scope: 'none', status, message };
  return { kind: 'unknown', scope: 'chunk', status, retryAt, message };
}
