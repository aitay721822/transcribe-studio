import { createHash } from 'node:crypto';
import type { AsrEvent, AsrSettings, SpeechSession } from '../../../domain/asr/config';
import type { AsrConnectionStatus, ConnectionAction } from '../../../domain/asr/connection';
import { realtimeRate, validateRealtime } from '../../../domain/asr/realtime';
import { AsrFailure, type FailureInfo, failureInfo, retryDelay } from '../../../domain/asr/retry';
import { acknowledge, completeCovered, coveredCandidates } from '../../../persistence/asr/coverage';
import type { AsrRepository } from '../../../persistence/asr/repository';
import { createAsrSession } from '../../../transport/asr';
import type { DurableLiveSession } from '../live';
import type { AudioSpool } from '../spool';
import { acquireProbe } from './probes';
import { ResponseWatchdog } from './watchdog';

interface RealtimeOptions {
  meetingId: string;
  recordingId: string;
  offset: number;
  repository: AsrRepository;
  spool: AudioSpool;
  settings(): AsrSettings;
  capture(offset: number): DurableLiveSession;
  emit(event: AsrEvent): void;
  status(value: AsrConnectionStatus): void;
  rtc(epoch: number): void;
  factory?: typeof createAsrSession;
  now?: () => number;
  random?: () => number;
}

function route(config: AsrSettings): string {
  return `realtime:${createHash('sha256')
    .update(
      JSON.stringify([
        config.provider,
        config.realtimeFlavor,
        config.url,
        config.signalingUrl,
        config.model,
      ])
    )
    .digest('hex')}`;
}

/** A fresh session per attempt. Audio time is independent of socket age and recorder wall time. */
export class RecoveringRealtimeSession implements SpeechSession {
  private client?: SpeechSession;
  private capture?: DurableLiveSession;
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private inflight?: Promise<void>;
  private rtcPending?: { resolve(): void; reject(error: Error): void };
  private received = 0;
  private rate: number;
  private provider: AsrSettings['provider'];
  private epochStart = 0;
  private routeId: string;
  private epoch = 0;
  private unknownFailures = 0;
  private responses: ResponseWatchdog;
  private stopped = false;
  private finishing = false;
  private paused = false;
  private closing?: Promise<void>;
  private cleanup: Promise<void> = Promise.resolve();
  private value: AsrConnectionStatus;

  constructor(private options: RealtimeOptions) {
    const config = options.settings();
    this.routeId = route(config);
    this.rate = realtimeRate(config);
    this.provider = config.provider;
    this.responses = new ResponseWatchdog(
      config.provider === 'openai' && config.realtimeFlavor !== 'vllm'
    );
    this.value = {
      meetingId: options.meetingId,
      recordingId: options.recordingId,
      state: 'connecting',
      attempts: 0,
      nextAttemptAt: 0,
      epoch: 0,
    };
    this.paused = options.repository.control(`realtime-paused:${options.recordingId}`);
  }

  private now(): number {
    return (this.options.now || Date.now)();
  }

  status(): AsrConnectionStatus {
    return { ...this.value };
  }

  current(epoch: number): boolean {
    return !this.stopped && this.epoch === epoch;
  }

  position(): number {
    return this.options.offset + this.received / (this.rate * 2);
  }

  origin(): number {
    return this.epochStart - this.options.offset;
  }

  private publish(
    state: AsrConnectionStatus['state'],
    error?: FailureInfo,
    nextAttemptAt = 0
  ): void {
    this.value = { ...this.value, state, error, nextAttemptAt, epoch: this.epoch };
    this.options.status(this.status());
  }

  private ensureCapture(): void {
    if (this.capture || !this.options.repository.autoRecovery(this.options.meetingId)) return;
    this.capture = this.options.capture(this.position());
    void this.capture
      .connect()
      .catch((error: unknown) =>
        this.options.emit({ type: 'warning', message: failureInfo(error).message })
      );
  }

  async connect(): Promise<void> {
    this.ensureCapture();
    this.watchdog = setInterval(() => this.check(), 1000);
    this.watchdog.unref?.();
    if (this.paused) {
      this.publish('paused');
      return;
    }
    const health = this.options.repository.health(this.routeId);
    if (health.error?.scope === 'none') {
      this.publish('needs_attention', health.error);
      return;
    }
    this.schedule(Math.max(this.now(), health.nextAttemptAt, health.notBefore));
  }

  private schedule(at: number): void {
    clearTimeout(this.timer);
    if (this.stopped || this.finishing || this.paused) return;
    const remaining = Math.max(0, at - this.now());
    if (remaining) this.publish('waiting_retry', this.value.error, at);
    this.timer = setTimeout(
      () => {
        if (at > this.now()) {
          this.schedule(at);
          return;
        }
        if (!this.inflight) {
          this.inflight = this.attempt().finally(() => {
            this.inflight = undefined;
          });
        } else this.schedule(this.now() + 50);
      },
      Math.min(remaining, 60000)
    );
    this.timer.unref?.();
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.finishing || this.paused) return;
    const health = this.options.repository.health(this.routeId);
    if (health.error?.scope === 'none') {
      this.publish('needs_attention', health.error);
      return;
    }
    const next = Math.max(health.nextAttemptAt, health.notBefore);
    if (next > this.now()) {
      this.schedule(next);
      return;
    }
    const release = acquireProbe(this.options.repository, this.routeId);
    if (!release) {
      this.schedule(this.now() + 250);
      return;
    }
    const epoch = ++this.epoch;
    this.value.attempts++;
    this.publish('connecting');
    try {
      const config = this.options.settings();
      if (config.provider !== this.provider || realtimeRate(config) !== this.rate)
        throw new AsrFailure({
          kind: 'configuration',
          scope: 'none',
          message: '錄音中變更協定或取樣率需先結束錄音，再建立新的錄音',
        });
      if (route(config) !== this.routeId)
        throw new AsrFailure({
          kind: 'configuration',
          scope: 'none',
          message: '即時服務設定已變更，請選擇「改用目前設定並重連」',
        });
      if (config.provider === 'openai') {
        try {
          validateRealtime(config);
        } catch {
          throw new AsrFailure({
            kind: 'configuration',
            scope: 'none',
            message: '請檢查即時辨識端點、模型與驗證設定',
          });
        }
      } else {
        const endpoint = URL.parse(config.provider === 'webrtc' ? config.signalingUrl : config.url);
        const protocols = config.provider === 'webrtc' ? ['http:', 'https:'] : ['ws:', 'wss:'];
        if (
          !endpoint ||
          !protocols.includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password
        )
          throw new AsrFailure({
            kind: 'configuration',
            scope: 'none',
            message: '即時辨識服務端點格式不正確',
          });
      }
      this.epochStart = this.position();
      if (config.provider === 'webrtc') {
        await new Promise<void>((resolve, reject) => {
          this.rtcPending = { resolve, reject };
          this.options.rtc(epoch);
          this.timer = setTimeout(
            () =>
              reject(
                new AsrFailure({
                  kind: 'connection',
                  scope: 'service',
                  message: 'WebRTC 連線或協商逾時',
                })
              ),
            20000
          );
        });
        clearTimeout(this.timer);
        this.rtcPending = undefined;
      } else {
        const client = (this.options.factory || createAsrSession)(config, (event) =>
          this.receive(event, epoch)
        );
        this.client = client;
        await client.connect();
      }
      if (this.finishing || !this.current(epoch) || this.paused) return;
      await this.capture?.rotate(true);
      if (this.finishing || !this.current(epoch) || this.paused) return;
      if (config.provider !== 'webrtc') this.epochStart = this.position();
      this.responses.reset();
      this.publish('connected');
    } catch (error) {
      if (this.current(epoch)) this.fail(failureInfo(error));
    } finally {
      release();
    }
  }

  audio(input: ArrayBuffer): boolean {
    if (this.stopped) return false;
    this.ensureCapture();
    this.capture?.audio(input);
    this.received += input.byteLength;
    if (this.value.state !== 'connected') return true;
    const bytes = Buffer.from(input);
    let power = 0;
    for (let index = 0; index + 1 < bytes.length; index += 2)
      power += (bytes.readInt16LE(index) / 32768) ** 2;
    this.responses.audio(Math.sqrt(power / Math.max(1, bytes.length / 2)) > 0.006, this.now());
    if (this.client && !this.client.audio(input))
      this.fail({
        kind: 'connection',
        scope: 'service',
        message: '即時音訊傳輸中斷，等待重新連線',
      });
    return true;
  }

  commit(): void {
    this.capture?.commit();
    if (this.value.state === 'connected') this.client?.commit();
  }

  receive(event: AsrEvent, epoch: number): void {
    if (!this.current(epoch) || this.paused) return;
    this.responses.receive(event, this.now());
    if (event.type === 'audio-committed') return;
    if (event.type === 'closed' || event.type === 'error') {
      this.fail(
        event.failure || {
          kind: 'connection',
          scope: 'service',
          message: '即時辨識連線中斷，音訊保留於補辨識任務',
        }
      );
      return;
    }
    if (event.type !== 'segment' || !event.segment) {
      this.options.emit(event);
      return;
    }
    const segment = {
      ...event.segment,
      id: `${epoch}:${event.segment.id}`,
      start: event.segment.start + this.epochStart - this.options.offset,
      end: event.segment.end + this.epochStart - this.options.offset,
    };

    const emit = () => this.options.emit({ ...event, segment });

    const reported =
      event.coverage || (event.segment.timing === 'provider' ? event.segment : undefined);
    const range =
      reported &&
      Number.isFinite(reported.start) &&
      Number.isFinite(reported.end) &&
      reported.start >= 0 &&
      reported.end > reported.start &&
      this.epochStart + reported.end <= this.position() + 0.05
        ? reported
        : undefined;
    if (segment.final && range) {
      const start = this.epochStart + range.start;
      const end = Math.min(this.position(), this.epochStart + range.end);
      acknowledge(this.options.repository, this.options.recordingId, start, end, emit);
      this.cleanup = this.cleanup
        .then(() => this.cleanCovered())
        .catch((error: unknown) => {
          this.options.emit({ type: 'warning', message: failureInfo(error).message });
        });
    } else {
      if (segment.final && !range) this.capture?.requireReview();
      emit();
    }
    if (segment.final) {
      this.unknownFailures = 0;
      this.options.repository.saveHealth({
        id: this.routeId,
        failures: 0,
        nextAttemptAt: 0,
        notBefore: 0,
      });
    }
  }

  private async cleanCovered(): Promise<void> {
    let after = '';
    while (true) {
      const chunks = coveredCandidates(this.options.repository, this.options.recordingId, after);
      if (!chunks.length) break;
      for (const chunk of chunks) {
        after = chunk.id;
        const completed = completeCovered(this.options.repository, chunk.id);
        if (completed) await this.options.spool.removeChunk(completed);
      }
    }
  }

  private fail(info: FailureInfo): void {
    if (
      this.stopped ||
      this.finishing ||
      this.paused ||
      this.value.state === 'waiting_retry' ||
      this.value.state === 'needs_attention'
    )
      return;
    this.epoch++;
    this.client?.ws?.terminate();
    this.client = undefined;
    this.rtcPending?.reject(new AsrFailure(info));
    this.rtcPending = undefined;
    this.responses.reset();
    if (this.options.repository.autoRecovery(this.options.meetingId))
      void this.capture
        ?.activate()
        .catch((error: unknown) =>
          this.options.emit({ type: 'warning', message: failureInfo(error).message })
        );
    const health = this.options.repository.health(this.routeId);
    health.failures++;
    if (info.scope === 'chunk') this.unknownFailures++;
    health.error = info;
    health.notBefore = Math.max(health.notBefore, info.retryAt || 0);
    health.nextAttemptAt = Math.max(
      health.notBefore,
      this.now() + retryDelay(health.failures, this.options.random?.())
    );
    if (info.scope === 'none' || this.unknownFailures >= 6) {
      health.error = { ...info, scope: 'none' };
      this.options.repository.saveHealth(health);
      this.publish('needs_attention', health.error);
    } else {
      this.options.repository.saveHealth(health);
      this.publish('waiting_retry', info, health.nextAttemptAt);
      this.schedule(health.nextAttemptAt);
    }
  }

  check(): void {
    if (this.value.state === 'connected' && this.responses.stalled(this.now()))
      this.fail({
        kind: 'timeout',
        scope: 'chunk',
        message: '有聲音訊已送出，但辨識結果等待逾時，將重連並補辨識缺口',
      });
  }

  rtcState(epoch: number, connected: boolean, error?: FailureInfo): void {
    if (!this.current(epoch)) return;
    if (connected) {
      this.epochStart = this.position();
      this.rtcPending?.resolve();
    } else
      this.fail(
        error || { kind: 'connection', scope: 'service', message: 'WebRTC 連線中斷，等待重新協商' }
      );
  }

  action(action: ConnectionAction): void {
    if (this.stopped || this.finishing) return;
    if (this.value.state === 'connected' && ['retry', 'resume'].includes(action)) return;
    if (action === 'pause') {
      this.paused = true;
      this.options.repository.saveControl(`realtime-paused:${this.options.recordingId}`, true);
      clearTimeout(this.timer);
      this.epoch++;
      this.client?.ws?.terminate();
      this.client = undefined;
      this.rtcPending?.reject(new Error('已暫停即時連線'));
      this.rtcPending = undefined;
      this.publish('paused');
      return;
    }
    if (action === 'retry' && this.paused) return;
    if (action === 'reconfigure') this.routeId = route(this.options.settings());
    if (action === 'reconfigure') {
      this.epoch++;
      this.client?.ws?.terminate();
      this.client = undefined;
      this.rtcPending?.reject(new Error('即時服務設定已更新'));
      this.rtcPending = undefined;
    }
    this.paused = false;
    this.options.repository.saveControl(`realtime-paused:${this.options.recordingId}`, false);
    const health = this.options.repository.health(this.routeId);
    health.error = undefined;
    health.nextAttemptAt = health.notBefore;
    this.options.repository.saveHealth(health);
    this.schedule(Math.max(this.now(), health.notBefore));
  }

  cancel(): void {
    void this.close();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.finishing = true;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    const client = this.client;
    this.closing = (async () => {
      if (client) await client.close();
      this.stopped = true;
      this.epoch++;
      this.rtcPending?.reject(new Error('即時辨識已結束'));
      await this.capture?.close();
      await this.cleanup;
      if (this.options.repository.autoRecovery(this.options.meetingId))
        await this.capture?.activate();
      this.publish('closed');
    })();
    return this.closing;
  }
}
