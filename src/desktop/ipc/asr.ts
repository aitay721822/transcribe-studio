import { realtimeRate } from '../../domain/asr/realtime';
import { createAsrSession, normalize } from '../../transport/asr';
import { signalOffer } from '../../transport/webrtc';
import type { DesktopContext } from '../context';

export function registerAsr(ctx: DesktopContext) {
  const { handle, store, asr, recordings, rtcCaches, meeting, settingsInternal, send } = ctx;
  handle('asr:start', async (id) => {
    meeting(id);
    if (asr.has(id)) throw new Error('ASR 已連線');
    const config = settingsInternal().asr;
    if (config.provider === 'webrtc')
      return { provider: 'webrtc', channel: config.channel, sampleRate: config.sampleRate };
    config.sampleRate = realtimeRate(config);
    const record = [...recordings.values()].find((r) => r.meetingId === id);
    const stream = createAsrSession(config, (ev) => {
      if (ev.type === 'segment') {
        ev.segment = {
          ...ev.segment,
          id: record ? `${record.id}:${ev.segment.id}` : ev.segment.id,
          providerId: ev.segment.id,
          start: ev.segment.start + (record?.offset || 0),
          end: ev.segment.end + (record?.offset || 0),
          recordingId: record?.id,
        };
        store.segment(id, ev.segment);
      }
      send('asr:event', { meetingId: id, ...ev });
    });
    asr.set(id, stream);
    try {
      await stream.connect();
      return { provider: config.provider, sampleRate: config.sampleRate };
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      asr.delete(id);
      await stream.close();
      throw e;
    }
  });
  handle('asr:audio', (id, bytes) => {
    if (bytes.byteLength > 256000) throw new Error('ASR 片段過大');
    return asr.get(id)?.audio(bytes) || false;
  });
  handle('asr:commit', (id) => asr.get(id)?.commit());
  handle('asr:stop', async (id) => {
    const s = asr.get(id);
    try {
      await s?.close();
    } finally {
      asr.delete(id);
      rtcCaches.delete(id);
    }
  });
  handle('rtc:signal', async (id, offer) => {
    meeting(id);
    const c = settingsInternal().asr;
    if (c.provider !== 'webrtc') throw new Error('請選擇 WebRTC ASR');
    return signalOffer(c, offer);
  });
  handle('rtc:event', (id, data, elapsed) => {
    meeting(id);
    const c = settingsInternal().asr;
    if (c.provider !== 'webrtc') throw new Error('ASR 類型錯誤');
    if (!rtcCaches.has(id)) rtcCaches.set(id, new Map());
    const seg = normalize(data, c, elapsed, rtcCaches.get(id));
    if (seg) {
      const record = [...recordings.values()].find((r) => r.meetingId === id);
      const saved = {
        ...seg,
        id: record ? `${record.id}:${seg.id}` : seg.id,
        providerId: seg.id,
        start: seg.start + (record?.offset || 0),
        end: seg.end + (record?.offset || 0),
        recordingId: record?.id,
      };
      store.segment(id, saved);
      send('asr:event', { meetingId: id, type: 'segment', segment: saved });
    }
  });
}
