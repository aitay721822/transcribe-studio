import { randomUUID } from 'node:crypto';
import type { TranscriptSegment } from '../../domain/models';
import { type TranscriptionConfig, validateTranscription } from '../../domain/transcription';
import { transcribeAudio } from './request';
import { pcmWav } from './wav';

interface Chunk {
  bytes: Buffer;
  start: number;
  end: number;
}
type Event =
  | { type: 'segment'; segment: TranscriptSegment }
  | { type: 'error' | 'status'; message: string };
/** Bounded FIFO of independently decodable WAV files; capture IPC never waits for inference. */
export class HttpTranscriptionSession {
  private controller = new AbortController();
  private parts: Buffer[] = [];
  private length = 0;
  private consumed = 0;
  private jobs: Chunk[] = [];
  private worker?: Promise<void>;
  private stopping?: Promise<void>;
  private ready = false;
  private failed = false;
  private cancelled = false;
  private limit = 0;
  private rate = 0;

  constructor(
    private config: TranscriptionConfig,
    private emit: (event: Event) => void
  ) {}

  async connect() {
    const { seconds } = validateTranscription(this.config);
    this.rate = Number(this.config.sampleRate || 24000);
    if (![16000, 24000, 48000].includes(this.rate)) throw new Error('HTTP 音訊取樣率無效');
    this.limit = Math.round(this.rate * seconds) * 2;
    this.ready = true;
  }

  audio(input: ArrayBuffer | Uint8Array): boolean {
    if (!this.ready || this.failed || this.cancelled) return false;
    const buffer = input instanceof ArrayBuffer ? Buffer.from(input) : Buffer.from(input);
    if (buffer.length > 256000 || buffer.length % 2) throw new Error('PCM16 音訊片段無效');
    let offset = 0;
    while (offset < buffer.length && !this.failed) {
      const size = Math.min(this.limit - this.length, buffer.length - offset);
      this.parts.push(Buffer.from(buffer.subarray(offset, offset + size)));
      this.length += size;
      offset += size;
      if (this.length === this.limit) this.commit();
    }
    return !this.failed;
  }

  commit() {
    if (!this.length || this.cancelled || this.failed) return;
    const bytes = Buffer.concat(this.parts, this.length);
    const start = this.consumed / (this.rate * 2);
    this.consumed += this.length;
    this.parts = [];
    this.length = 0;
    let power = 0;
    for (let i = 0; i < bytes.length; i += 2) power += (bytes.readInt16LE(i) / 32768) ** 2;
    if (Math.sqrt(power / (bytes.length / 2)) < 0.006) return;
    if (this.jobs.length + (this.worker ? 1 : 0) >= 4) {
      this.fail('HTTP 辨識速度不足，已停止上傳；會議錄音仍保留，可於會後補辨識');
      return;
    }
    this.jobs.push({ bytes, start, end: this.consumed / (this.rate * 2) });
    if (!this.worker) {
      this.worker = this.drain().finally(() => {
        this.worker = undefined;
      });
    }
  }

  private async drain() {
    while (this.jobs.length && !this.controller.signal.aborted) {
      const chunk = this.jobs.shift();
      try {
        this.emit({ type: 'status', message: '正在上傳音訊分段並等待 HTTP 辨識…' });
        const text = await transcribeAudio(
          this.config,
          pcmWav(chunk.bytes, this.rate),
          'segment.wav',
          this.controller.signal,
          30000
        );
        if (!this.controller.signal.aborted && text.trim())
          this.emit({
            type: 'segment',
            segment: {
              id: randomUUID(),
              text,
              start: chunk.start,
              end: chunk.end,
              speaker: '',
              final: true,
              timing: 'approximate',
            },
          });
      } catch (caughtE) {
        const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

        if (!this.cancelled && !this.controller.signal.aborted) this.fail(e.message);
      }
    }
  }

  private fail(message: string) {
    if (this.failed || this.cancelled) return;
    this.failed = true;
    this.ready = false;
    this.jobs = [];
    this.parts = [];
    this.length = 0;
    this.controller.abort();
    this.emit({ type: 'error', message });
  }

  cancel() {
    this.cancelled = true;
    this.ready = false;
    this.jobs = [];
    this.parts = [];
    this.length = 0;
    this.controller.abort();
  }

  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ready = false;
    this.commit();
    this.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.worker,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              this.fail('HTTP 最後逐字稿等待逾時；會議音訊已保留，可於會後補辨識');
              resolve();
            }, 35000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.cancel();
        await this.worker;
      }
    })();
    return this.stopping;
  }
}
