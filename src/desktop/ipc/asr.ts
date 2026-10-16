import { realtimeRate } from '../../domain/asr/realtime';
import { credentialRedactor } from '../../services/security/redaction';
import { createAsrSession } from '../../transport/asr';
import { registerRealtime } from '../asr/realtime';
import type { DesktopContext } from '../context';

export function registerAsr(ctx: DesktopContext) {
  registerRealtime(ctx);
  const { handle, store, asr, recordings, rtcCaches, meeting, settingsInternal, send } = ctx;
  handle('asr:start', async (id) => {
    meeting(id);
    if (asr.has(id)) throw new Error('ASR 已連線');
    const config = settingsInternal().asr;
    const redact = credentialRedactor({ asr: config });
    config.sampleRate = realtimeRate(config);
    const record = [...recordings.values()].find((r) => r.meetingId === id);

    const emit = (ev: import('../../domain/asr/config').AsrEvent) => {
      if (ev.message) ev.message = redact.text(ev.message);
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
    };

    let stream: import('../../domain/asr/config').SpeechSession;
    if (config.provider === 'transcriptions' && record) {
      stream = ctx.asrTasks.createLive({
        meetingId: id,
        recordingId: record.id,
        offset: record.offset,
        config,

        emit: (event) => send('asr:event', { meetingId: id, ...event }),
      });
    } else if (record) {
      stream = ctx.asrTasks.createRealtime({
        meetingId: id,
        recordingId: record.id,
        offset: record.offset,
        emit,

        status: (value) => send('asr:connection', value),

        rtc: (epoch) => {
          rtcCaches.delete(id);
          send('asr:event', { type: 'rtc-connect', meetingId: id, epoch });
        },
      });
    } else stream = createAsrSession(config, emit);
    asr.set(id, stream);
    try {
      await stream.connect();
      return { provider: config.provider, sampleRate: config.sampleRate };
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      asr.delete(id);
      await stream.close();
      throw new Error(redact.text(e.message));
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
}
