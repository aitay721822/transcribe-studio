import type { AsrSettings } from '../domain/asr/config';

export async function signalOffer(
  config: AsrSettings,
  offer: string,
  signal = AbortSignal.timeout(20000)
) {
  if (typeof offer !== 'string' || offer.length > 100000) throw new Error('SDP 無效');
  const url = new URL(config.signalingUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Signaling 需使用 HTTP(S)');
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      ...config.headers,
      'Content-Type': config.signalingMode === 'sdp' ? 'application/sdp' : 'application/json',
    },
    body:
      config.signalingMode === 'sdp'
        ? offer
        : JSON.stringify({ type: 'offer', sdp: offer, ...config.init }),
  });
  if (!response.ok) throw new Error(`WebRTC signaling 失敗 (${response.status})`);
  const result =
    config.signalingMode === 'sdp' ? { sdp: await response.text() } : await response.json();
  if (typeof result.sdp !== 'string' || result.sdp.length > 100000)
    throw new Error('Signaling 回應需要有效的 sdp');
  return { type: 'answer' as const, sdp: result.sdp };
}
