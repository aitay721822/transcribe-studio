import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AsrEvent, AsrSettings, SpeechSession } from '../domain/asr/config';
import { validateRealtime } from '../domain/asr/realtime';
import { AsrFailure, failureInfo, httpFailure, retryAfter } from '../domain/asr/retry';
import type { TranscriptSegment } from '../domain/models';
import { record } from '../domain/value';
import { RealtimeCoverage } from './realtime/coverage';
import { vllmTranscript } from './realtime/vllm';
import { HttpTranscriptionSession } from './transcription/session';

function field(o: unknown, key: string) {
  return String(key || '')
    .split('.')
    .reduce<unknown>(
      (v, k) =>
        v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined,
      o
    );
}

function normalize(
  value: unknown,
  config: AsrSettings,
  elapsed: number,
  cache: Map<string, TranscriptSegment>
): TranscriptSegment {
  const data = record(value);
  const type = typeof data.type === 'string' ? data.type : '';
  if (config.provider === 'openai') {
    if (type === 'error') throw protocolFailure(data);
    if (config.realtimeFlavor === 'vllm') return vllmTranscript(data, elapsed, cache);
    if (
      ![
        'conversation.item.input_audio_transcription.delta',
        'conversation.item.input_audio_transcription.completed',
      ].includes(type)
    )
      return null;
    const id = typeof data.item_id === 'string' ? data.item_id : randomUUID();
    const prev = cache.get(id);

    const transcriptText = () => {
      if (type.endsWith('.delta')) {
        return `${prev?.text || ''}${typeof data.delta === 'string' ? data.delta : ''}`;
      }
      if (typeof data.transcript === 'string') {
        return data.transcript;
      }
      return '';
    };

    const seg = {
      id,
      start: prev?.start ?? elapsed,
      end: elapsed,
      text: transcriptText(),
      final: type.endsWith('.completed'),
      speaker: '',
      timing: 'received',
    };
    cache.set(id, seg);
    return seg;
  }
  const m = config.mapping;
  const text = field(data, m.text);
  if (typeof text !== 'string') return null;
  const id = String(field(data, m.id) ?? randomUUID());
  const finalValue = field(data, m.final);
  const start = field(data, m.start);
  const end = field(data, m.end);
  const seg = {
    id,
    text,
    final: finalValue === true || finalValue === 'true' || finalValue === 1,
    speaker: String(field(data, m.speaker) ?? ''),
    start:
      Number.isFinite(Number(start)) && start != null
        ? Number(start)
        : (cache.get(id)?.start ?? elapsed),
    end: Number.isFinite(Number(end)) && end != null ? Number(end) : elapsed,
    timing: start != null ? 'provider' : 'received',
  };
  cache.set(id, seg);
  return seg;
}

function protocolFailure(data: Record<string, unknown>): AsrFailure {
  const error = record(data.error);
  const code = String(error.code || error.type || '');
  if (
    [
      'invalid_api_key',
      'authentication_error',
      'permission_denied',
      'model_not_found',
      'insufficient_quota',
      'billing_hard_limit_reached',
    ].includes(code)
  )
    return new AsrFailure({
      kind: 'configuration',
      scope: 'none',
      message: '即時辨識服務的驗證、模型或額度設定需要處理',
    });
  if (code === 'rate_limit_exceeded') return new AsrFailure(httpFailure(429));
  return new AsrFailure({
    kind: 'unknown',
    scope: 'chunk',
    message: '即時辨識服務回報錯誤，音訊已保留',
  });
}

class AsrSession {
  ws: WebSocket;
  cache = new Map<string, TranscriptSegment>();
  started: number;
  closed: boolean;
  ready: boolean;
  audioBytes: number;
  pendingCommits: number;
  private coverage = new RealtimeCoverage();

  constructor(
    private config: AsrSettings,
    private emit: (event: AsrEvent) => void
  ) {
    this.cache = new Map<string, TranscriptSegment>();
    this.started = Date.now();
    this.closed = false;
    this.ready = false;
    this.audioBytes = 0;
    this.pendingCommits = 0;
  }

  async connect() {
    const c = this.config;
    const vllm = c.provider === 'openai' && c.realtimeFlavor === 'vllm';
    const url = new URL(c.url);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('ASR URL 必須使用 ws 或 wss');
    if (c.provider === 'openai') validateRealtime(c);
    if (c.provider === 'openai' && !vllm) {
      url.searchParams.set('intent', 'transcription');
      url.searchParams.delete('model');
    }
    const headers =
      c.provider === 'openai'
        ? { ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}), ...c.headers }
        : c.headers;
    this.ws = new WebSocket(url, { headers, handshakeTimeout: 15000, maxPayload: 2 * 1024 * 1024 });
    this.ws.on('unexpected-response', (_request, response) => {
      const value = response.headers['retry-after'];
      const failure = httpFailure(
        response.statusCode || 500,
        retryAfter(typeof value === 'string' ? value : null, Date.now())
      );
      response.resume();
      this.ws.emit('error', new AsrFailure(failure));
      this.ws.terminate();
    });
    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this.coverage.receive(data);
        const seg = normalize(data, c, (Date.now() - this.started) / 1000, this.cache);
        if (seg?.final && c.provider === 'openai')
          this.pendingCommits = vllm ? 0 : Math.max(0, this.pendingCommits - 1);
        if (seg) {
          const range = this.coverage.range(seg.id);
          if (range) {
            seg.start = range.start;
            seg.end = range.end;
            seg.timing = 'provider';
          }
          let coverage = seg.final ? this.coverage.finish(seg.id) : undefined;
          if (seg.final && vllm && this.closed) coverage = this.coverage.all();
          this.emit({ type: 'segment', segment: seg, coverage });
          if (seg.final) this.cache.delete(seg.id);
        }
      } catch (caughtE) {
        const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

        this.emit({ type: 'error', message: e.message, failure: failureInfo(e) });
      }
    });
    this.ws.on('error', (e) =>
      this.emit({ type: 'error', message: failureInfo(e).message, failure: failureInfo(e) })
    );
    this.ws.on('close', () => {
      this.ready = false;
      this.emit({
        type: 'closed',
        message: this.closed ? '串流已結束' : 'ASR 連線中斷，本地錄音仍持續',
      });
    });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.ws.off('message', initialized);
        this.ws.off('error', failed);
        this.ws.off('close', disconnected);
        if (error) reject(error);
        else {
          this.ready = true;
          resolve();
        }
      };

      const failed = (e: Error) => finish(e);

      const disconnected = () => finish(new Error('ASR 初始化前已中斷連線'));

      const initialized = (raw: import('ws').RawData) => {
        try {
          const data = JSON.parse(raw.toString());
          if (vllm && data.type === 'session.created') {
            this.ws.send(JSON.stringify({ type: 'session.update', model: c.model }));
            this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            finish();
          }
          if (['session.updated', 'transcription_session.updated'].includes(data.type)) finish();
          if (data.type === 'error') finish(protocolFailure(record(data)));
        } catch (caughtE) {
          const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

          finish(e);
        }
      };

      const timer = setTimeout(() => {
        finish(
          new AsrFailure({ kind: 'connection', scope: 'service', message: 'ASR 連線或初始化逾時' })
        );
        this.ws.terminate();
      }, 20000);
      this.ws.once('error', failed);
      this.ws.once('close', disconnected);
      if (c.provider === 'openai') this.ws.on('message', initialized);
      this.ws.once('open', () => {
        if (this.closed) {
          finish(new Error('連線已取消'));
          this.ws.close();
          return;
        }
        if (vllm) return;
        if (c.provider === 'openai')
          this.ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'transcription',
                audio: {
                  input: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    transcription: { model: c.model },
                    turn_detection: null,
                  },
                },
              },
            })
          );
        else {
          if (Object.keys(c.init || {}).length) this.ws.send(JSON.stringify(c.init));
          finish();
        }
      });
    });
  }

  audio(buffer: ArrayBuffer | Uint8Array) {
    if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > 4 * 1024 * 1024) {
      this.emit({ type: 'error', message: 'ASR 傳送速度不足，請使用本地音訊補辨識' });
      return false;
    }
    const c = this.config;
    const b = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : Buffer.from(buffer);
    this.audioBytes += b.length;
    this.coverage.audio(b.length, this.config.sampleRate || 24000);
    if (c.provider === 'openai')
      this.ws.send(
        JSON.stringify({ type: 'input_audio_buffer.append', audio: b.toString('base64') })
      );
    else if (c.audioMode === 'json')
      this.ws.send(
        JSON.stringify({ ...c.audioEnvelope, [c.audioField || 'audio']: b.toString('base64') })
      );
    else this.ws.send(b);
    return true;
  }

  commit() {
    if (this.config.realtimeFlavor === 'vllm' && this.config.provider === 'openai') return;
    if (this.pendingCommits >= 64) {
      this.emit({
        type: 'error',
        failure: {
          kind: 'timeout',
          scope: 'chunk',
          message: '即時服務未完成已提交回合，將保留音訊並重新連線',
        },
      });
      return;
    }
    if (
      this.config.provider === 'openai' &&
      this.ready &&
      this.ws.readyState === WebSocket.OPEN &&
      this.audioBytes >= 4800
    ) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      this.emit({ type: 'audio-committed', coverage: this.coverage.commit() });
      this.audioBytes = 0;
      this.pendingCommits++;
    }
  }

  async close() {
    if (this.closed) return;
    if (
      this.config.provider === 'openai' &&
      this.config.realtimeFlavor === 'vllm' &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', final: true }));
      if (this.audioBytes) this.pendingCommits++;
    }
    this.commit();
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      const deadline = Date.now() + (this.config.provider === 'openai' ? 10000 : 600);
      while (
        Date.now() < deadline &&
        this.ws.readyState === WebSocket.OPEN &&
        (this.config.provider !== 'openai' || this.pendingCommits > 0)
      )
        await new Promise<void>((r) => setTimeout(r, 100));
      if (this.pendingCommits > 0)
        this.emit({
          type: 'error',
          message: '部分完成逐字稿未及回傳；音訊已保留，可使用會後補辨識',
        });
      this.ws.close();
    } else this.ws?.terminate();
  }
}

function createAsrSession(config: AsrSettings, emit: (event: AsrEvent) => void): SpeechSession {
  return config.provider === 'transcriptions'
    ? new HttpTranscriptionSession(config, emit)
    : new AsrSession(config, emit);
}

export { AsrSession, createAsrSession, field, normalize };
