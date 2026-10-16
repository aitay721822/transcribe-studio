import type { Invoke } from '../../../domain/ipc';

export async function openRecordingRtc(
  id: string,
  epoch: number,
  stream: MediaStream,
  api: Invoke,
  elapsed: () => number,
  signal: AbortSignal
): Promise<RTCPeerConnection> {
  const config = await api('rtc:config', id, epoch);
  signal.throwIfAborted();
  const pc = new RTCPeerConnection({ iceServers: config.iceServers || [] });
  signal.addEventListener('abort', () => pc.close(), { once: true });
  let ready = false;
  const pending: { data: unknown; elapsed: number }[] = [];

  const send = (data: unknown, time: number) => {
    if (!signal.aborted) void api('rtc:event', id, data, time, epoch).catch(() => {});
  };

  const receive = (channel: RTCDataChannel) => {
    channel.onmessage = (event) => {
      if (signal.aborted) return;
      try {
        const data: unknown = JSON.parse(event.data);
        if (ready) send(data, elapsed());
        else if (pending.length < 30) pending.push({ data, elapsed: elapsed() });
      } catch {
        void api('rtc:state', id, epoch, false, {
          kind: 'unknown',
          scope: 'chunk',
          message: 'WebRTC 逐字稿回應不是有效 JSON',
        }).catch(() => {});
      }
    };
  };

  const channel = pc.createDataChannel(config.channel || 'transcript');
  receive(channel);
  pc.ondatachannel = (event) => receive(event.channel);
  stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

  const wait = (check: () => boolean, event: string, target: EventTarget) =>
    new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        target.removeEventListener(event, changed);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };

      const changed = () => {
        if (check()) finish();
        else if (['failed', 'closed'].includes(pc.connectionState))
          finish(new Error('WebRTC 連線已結束'));
      };

      const abort = () => finish(new Error('WebRTC 連線已取消'));

      const timer = setTimeout(() => finish(new Error('WebRTC 協商逾時')), 18000);
      target.addEventListener(event, changed);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else changed();
    });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await wait(() => pc.iceGatheringState === 'complete', 'icegatheringstatechange', pc);
    await pc.setRemoteDescription(await api('rtc:signal', id, pc.localDescription.sdp, epoch));
    await wait(() => pc.connectionState === 'connected', 'connectionstatechange', pc);
    await wait(() => channel.readyState === 'open', 'open', channel);
    signal.throwIfAborted();
    await api('rtc:state', id, epoch, true);
    ready = true;
    for (const message of pending) send(message.data, message.elapsed);
    pc.onconnectionstatechange = () => {
      if (!signal.aborted && ['failed', 'disconnected'].includes(pc.connectionState))
        void api('rtc:state', id, epoch, false).catch(() => {});
    };
    return pc;
  } catch (error) {
    pc.close();
    if (!signal.aborted)
      void api('rtc:state', id, epoch, false, {
        kind: 'connection',
        scope: 'service',
        message: 'WebRTC 無法連線或協商逾時，等待重新建立連線',
      }).catch(() => {});
    throw error;
  }
}
