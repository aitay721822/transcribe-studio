import { agentAuth } from './agents/auth';
import { validateRealtime } from './asr/realtime';
import type { Settings } from './models';
import { validateTranscription } from './transcription';

function endpoint(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function asrConnectionReady(asr: Settings['asr']): boolean {
  try {
    if (asr.provider === 'openai') {
      validateRealtime(asr);
      return true;
    }
    if (asr.provider === 'transcriptions') {
      validateTranscription(asr);
      return true;
    }
    return asr.provider === 'websocket'
      ? endpoint(asr.url, ['ws:', 'wss:'])
      : asr.provider === 'webrtc' && endpoint(asr.signalingUrl, ['http:', 'https:']);
  } catch {
    return false;
  }
}

/** Structural readiness is separate from installation discovery and remote authentication. */
export function setupReadiness(settings: Settings) {
  const { asr, llm } = settings;
  let httpReady = false;
  let realtimeReady = false;
  try {
    validateRealtime(asr);
    realtimeReady = true;
  } catch {}
  try {
    validateTranscription(asr);
    httpReady = true;
  } catch {}
  const asrReady = httpReady && asrConnectionReady(asr);

  const agentCredentialsReady = () => {
    if (agentAuth(llm) === 'cli') {
      return true;
    }
    if (llm.backend === 'claude') {
      return !!(llm.claudeKey?.trim() && llm.claudeModel?.trim());
    }
    return !!(
      llm.apiKey?.trim() &&
      llm.model?.trim() &&
      endpoint(llm.baseUrl, ['http:', 'https:'])
    );
  };

  const agentReady = agentCredentialsReady();
  return {
    offline: httpReady,
    realtime: realtimeReady,
    asr: !!asrReady,
    agent: agentReady,
    complete: !!asrReady && agentReady,
  };
}
