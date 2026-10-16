import type { Invoke, SpeechConnection } from '../../../domain/ipc';

export async function connectTestRtc(
  id: string,
  config: SpeechConnection,
  stream: MediaStream,
  api: Invoke,
  signal: AbortSignal,
  error: (message: string) => void
) {
  const pc = new RTCPeerConnection({ iceServers: config.iceServers || [] });
  signal.addEventListener('abort', () => pc.close(), { once: true });

  const receive = (channel: RTCDataChannel) => {
    channel.onmessage = (event) => {
      try {
        void api('connection:rtc-event', id, JSON.parse(event.data)).catch((e) => error(e.message));
      } catch {
        error('WebRTC 辨識事件不是 JSON');
      }
    };
  };

  const channel = pc.createDataChannel(config.channel || 'transcript');
  receive(channel);
  pc.ondatachannel = (event) => receive(event.channel);
  stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

  const wait = (ready: () => boolean, event: string, target: EventTarget) =>
    new Promise<void>((resolve, reject) => {
      const finish = (reason?: Error) => {
        clearTimeout(timer);
        target.removeEventListener(event, changed);
        signal.removeEventListener('abort', cancelled);
        reason ? reject(reason) : resolve();
      };

      const changed = () => {
        if (ready()) finish();
        else if (['failed', 'closed'].includes(pc.connectionState))
          finish(new Error('WebRTC 連線失敗'));
      };

      const cancelled = () => finish(new Error('測試已取消'));

      const timer = setTimeout(() => finish(new Error('WebRTC 連線逾時')), 20000);
      target.addEventListener(event, changed);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      else changed();
    });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await wait(() => pc.iceGatheringState === 'complete', 'icegatheringstatechange', pc);
    await pc.setRemoteDescription(await api('connection:rtc-signal', id, pc.localDescription.sdp));
    await wait(() => pc.connectionState === 'connected', 'connectionstatechange', pc);
    await wait(() => channel.readyState === 'open', 'open', channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState) && !signal.aborted)
        error('WebRTC 測試連線中斷');
    };
    return pc;
  } catch (caughtE) {
    const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

    pc.close();
    throw e;
  }
}
