import type { AsrSettings, SpeechSession } from '../../domain/asr/config';
import { realtimeRate } from '../../domain/asr/realtime';
import type { ConnectionEvent } from '../../domain/ipc';
import type { Settings, TranscriptSegment } from '../../domain/models';
import { asrConnectionReady } from '../../domain/readiness';
import { createAsrSession, normalize } from '../../transport/asr';
import { signalOffer } from '../../transport/webrtc';

interface Entry {
  config: AsrSettings;
  session?: SpeechSession;
  controller: AbortController;
  cache: Map<string, TranscriptSegment>;
  timer: ReturnType<typeof setTimeout>;
  started: number;
  stopping?: Promise<void>;
  silentStop?: boolean;
}
export class AsrConnectionTests {
  private sessions = new Map<string, Entry>();

  constructor(private emit: (id: string, event: ConnectionEvent) => void) {}

  async start(id: string, settings: Settings) {
    if (this.sessions.size || this.sessions.has(id)) throw new Error('請先結束目前的辨識測試');
    if (!asrConnectionReady(settings.asr)) throw new Error('請先填妥辨識服務必要欄位');
    const config = structuredClone(settings.asr);
    config.sampleRate = realtimeRate(config);
    const entry: Entry = {
      config,
      controller: new AbortController(),
      cache: new Map(),
      started: Date.now(),
      timer: setTimeout(() => {
        this.emit(id, { type: 'timeout', message: '已達 90 秒測試上限' });
        void this.stop(id, false);
      }, 90000),
    };
    this.sessions.set(id, entry);
    try {
      if (config.provider !== 'webrtc') {
        entry.session = createAsrSession(config, (event) => {
          if (event.type === 'closed' && entry.stopping) return;
          if (event.type === 'error' && entry.silentStop) return;
          this.emit(id, event);
        });
        await entry.session.connect();
      }
      entry.controller.signal.throwIfAborted();
      return {
        provider: config.provider,
        sampleRate: config.sampleRate,
        chunkSeconds: config.chunkSeconds || 5,
        channel: config.channel,
        iceServers: config.iceServers,
      };
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      await this.stop(id, false);
      throw error;
    }
  }

  audio(id: string, bytes: ArrayBuffer) {
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes))
      throw new Error('音訊格式無效');
    if (bytes.byteLength > 256000) throw new Error('測試音訊片段過大');
    return this.sessions.get(id)?.session?.audio(bytes) || false;
  }

  commit(id: string) {
    this.sessions.get(id)?.session?.commit();
  }

  async signal(id: string, offer: string) {
    const entry = this.entry(id);
    if (entry.config.provider !== 'webrtc') throw new Error('不是 WebRTC 測試');
    return signalOffer(
      entry.config,
      offer,
      AbortSignal.any([entry.controller.signal, AbortSignal.timeout(20000)])
    );
  }

  event(id: string, data: unknown) {
    const entry = this.entry(id);
    if (entry.config.provider !== 'webrtc' || JSON.stringify(data).length > 100000)
      throw new Error('辨識事件無效');
    const segment = normalize(data, entry.config, (Date.now() - entry.started) / 1000, entry.cache);
    if (segment) this.emit(id, { type: 'segment', segment });
  }

  private entry(id: string) {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error('測試已結束');
    return entry;
  }

  async stop(id: string, graceful = true) {
    const entry = this.sessions.get(id);
    if (!entry) return;
    if (entry.stopping) return entry.stopping;
    entry.silentStop = !graceful;
    entry.stopping = (async () => {
      clearTimeout(entry.timer);
      entry.controller.abort(new Error('測試已結束'));
      try {
        if (graceful) await entry.session?.close();
        else {
          entry.session?.cancel?.();
          entry.session?.ws?.terminate();
        }
      } finally {
        this.sessions.delete(id);
      }
    })();
    return entry.stopping;
  }

  async close() {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id, false)));
  }
}
