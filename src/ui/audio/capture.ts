import type { AsrEvent, AsrSettings } from '../../domain/asr/config';
import { realtimeRate } from '../../domain/asr/realtime';
import type { Invoke } from '../../domain/ipc';
import { AudioHealth } from './lifecycle/health';
import { flushPcm } from './lifecycle/pcm';
import { openRecordingRtc } from './lifecycle/rtc';
import { openAudioSources } from './sources';

export class AudioCapture {
  active: boolean;
  paused: boolean;
  sources: MediaStream[];
  started: number;
  asrActive: boolean;
  localQueue: Promise<unknown>;
  streamQueue: Promise<unknown>;
  pending: number;
  starting = false;
  stopping = false;
  id: string;
  rid: string;
  offset = 0;
  pauseMs = 0;
  pauseAt = 0;
  context: AudioContext;
  mix: GainNode;
  destination: MediaStreamAudioDestinationNode;
  worklet: AudioWorkletNode;
  recorder: MediaRecorder;
  pc: RTCPeerConnection;
  private rtcController?: AbortController;
  rtcEpoch = 0;
  writeError: unknown;
  private savedSeconds = 0;
  lastCommit = 0;
  lastVoice = 0;
  hasVoice = false;

  constructor(
    private api: Invoke,
    private events: (event: AsrEvent) => void
  ) {
    this.active = false;
    this.paused = false;
    this.sources = [];
    this.started = 0;
    this.asrActive = false;
    this.localQueue = Promise.resolve();
    this.streamQueue = Promise.resolve();
    this.pending = 0;
  }

  elapsed() {
    return this.active
      ? (Date.now() - this.started - this.pauseMs - (this.paused ? Date.now() - this.pauseAt : 0)) /
          1000 +
          (this.offset || 0)
      : 0;
  }

  async start(
    meetingId: string,
    source: string,
    recordOnly: boolean,
    settings: AsrSettings,
    offset = 0,
    microphoneId = '',
    playbackId = ''
  ) {
    if (this.active || this.starting) throw new Error('錄音已啟動');
    this.starting = true;
    this.id = meetingId;
    this.offset = offset;
    this.pauseMs = 0;
    this.sources = [];
    this.localQueue = Promise.resolve();
    this.streamQueue = Promise.resolve();
    this.writeError = null;
    this.savedSeconds = 0;
    try {
      this.sources = await openAudioSources(source, microphoneId, playbackId);
      this.context = new AudioContext();
      this.mix = this.context.createGain();
      this.mix.gain.value = source === 'both' ? 0.5 : 1;
      for (const stream of this.sources)
        this.context
          .createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
          .connect(this.mix);
      this.destination = this.context.createMediaStreamDestination();
      this.mix.connect(this.destination);
      const rate = realtimeRate(settings);
      await this.context.audioWorklet.addModule('./audio/pcm-worklet.js');
      this.worklet = new AudioWorkletNode(this.context, 'studio-pcm', {
        processorOptions: { rate },
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        outputChannelCount: [1],
      });
      this.mix.connect(this.worklet);
      const silent = this.context.createGain();
      silent.gain.value = 0;
      this.worklet.connect(silent).connect(this.context.destination);
      this.rid = await this.api('audio:start', meetingId);
      this.recorder = new MediaRecorder(this.destination.stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 64000,
      });
      this.recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        const end = this.active ? this.elapsed() - this.offset : this.savedSeconds;
        this.localQueue = this.localQueue
          .then(async () => {
            if (this.writeError) return;
            await this.api('audio:chunk', this.rid, await e.data.arrayBuffer());
            this.savedSeconds = end;
          })
          .catch((err: unknown) => {
            this.writeError = err;
            this.events({
              type: 'source-ended',
              message: `本地錄音寫入失敗，已停止收音；最後成功保存至 ${this.savedSeconds.toFixed(1)} 秒。`,
            });
          });
      };
      this.recorder.start(1000);
      this.started = Date.now();
      this.active = true;
      this.paused = false;
      this.lastCommit = Date.now();
      this.lastVoice = 0;
      this.hasVoice = false;
      const health =
        source === 'mic'
          ? undefined
          : new AudioHealth((message) => this.events({ type: 'warning', message }));
      this.worklet.port.onmessage = ({
        data,
      }: MessageEvent<{ level?: number; audio?: ArrayBuffer }>) => {
        if (!this.active || this.paused) return;
        if ('level' in data) {
          health?.sample(
            data.level,
            this.sources[0]?.getAudioTracks().some((track) => track.muted)
          );
          this.events({ type: 'level', level: data.level });
          if (data.level > 0.012) {
            this.lastVoice = Date.now();
            this.hasVoice = true;
          }
          if (
            this.asrActive &&
            settings.provider === 'openai' &&
            this.hasVoice &&
            ((Date.now() - this.lastVoice > 900 && Date.now() - this.lastCommit > 500) ||
              Date.now() - this.lastCommit > 12000)
          ) {
            this.hasVoice = false;
            this.lastCommit = Date.now();
            this.streamQueue = this.streamQueue
              .then(() => this.api('asr:commit', this.id))
              .catch(() => {});
          }
        }
        if (data.audio && this.asrActive) {
          if (this.pending > 30) {
            this.asrActive = false;
            this.events({ type: 'error', message: 'ASR 串流壅塞，本地錄音仍持續；停止後可補辨識' });
            return;
          }
          this.pending++;
          this.streamQueue = this.streamQueue
            .then(() => this.api('asr:audio', this.id, data.audio))
            .then((ok) => {
              if (!ok && this.asrActive) {
                this.asrActive = false;
                this.events({ type: 'error', message: 'ASR 連線中斷，本地錄音仍持續' });
              }
            })
            .catch((err) => {
              this.asrActive = false;
              this.events({ type: 'error', message: err.message });
            })
            .finally(() => this.pending--);
        }
      };
      if (!recordOnly) {
        try {
          await this.api('asr:start', meetingId);
          this.asrActive = true;
        } catch (caughtErr) {
          const err = caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));

          await this.api('asr:stop', meetingId).catch(() => {});
          this.events({ type: 'error', message: `ASR 未連線：${err.message}。本地錄音仍持續。` });
        }
      }
      this.events({ type: 'started', asr: this.asrActive });
      for (const s of this.sources)
        for (const t of s.getAudioTracks())
          t.onended = () => {
            if (this.active)
              this.events({ type: 'source-ended', message: '音訊來源已結束，正在儲存錄音' });
          };
    } catch (caughtErr) {
      const err = caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));

      if (this.rid && this.active) await this.stop().catch(() => {});
      else {
        for (const s of this.sources) s.getTracks().forEach((t) => t.stop());
        await this.context?.close().catch(() => {});
        if (this.rid) await this.api('audio:finish', this.rid, 0).catch(() => {});
      }
      throw err;
    } finally {
      this.starting = false;
    }
  }

  async connectRTC(epoch: number): Promise<void> {
    if (!this.active || this.stopping) return;
    this.disconnectRTC();
    this.rtcEpoch = epoch;
    const controller = new AbortController();
    this.rtcController = controller;
    try {
      const pc = await openRecordingRtc(
        this.id,
        epoch,
        this.destination.stream,
        this.api,
        () => this.elapsed() - (this.offset || 0),
        controller.signal
      );
      if (controller.signal.aborted || this.rtcEpoch !== epoch) pc.close();
      else this.pc = pc;
    } catch {
      /* The main-process coordinator owns retry policy and status. */
    }
  }

  disconnectRTC(): void {
    this.rtcController?.abort();
    this.pc?.close();
    this.pc = undefined;
  }

  async togglePause() {
    if (!this.active) return;
    if (this.paused) {
      this.pauseMs += Date.now() - this.pauseAt;
      await this.context.resume();
      this.recorder.resume();
      this.destination.stream.getAudioTracks().forEach((t) => (t.enabled = true));
      this.paused = false;
    } else {
      await this.streamQueue;
      await this.api('asr:commit', this.id);
      this.pauseAt = Date.now();
      this.recorder.pause();
      await this.context.suspend();
      this.destination.stream.getAudioTracks().forEach((t) => (t.enabled = false));
      this.paused = true;
    }
    this.events({ type: 'paused', paused: this.paused });
  }

  async stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    const duration = this.elapsed() - (this.offset || 0);
    try {
      for (const s of this.sources) s.getTracks().forEach((t) => t.stop());
      if (this.context.state === 'suspended') await this.context.resume();
      await flushPcm(this.worklet, this.context);
      this.active = false;
      await new Promise<void>((resolve) => {
        this.recorder.onstop = () => resolve();
        this.recorder.stop();
      });
      await this.localQueue;
      await this.streamQueue;
      await this.api('asr:stop', this.id);
      this.pc?.close();
      this.disconnectRTC();
      for (const s of this.sources) s.getTracks().forEach((t) => t.stop());
      await this.context.close();
      const result = await this.api(
        'audio:finish',
        this.rid,
        this.writeError ? this.savedSeconds : duration,
        !!this.writeError
      );
      if (this.writeError) throw this.writeError;
      if (result.status === 'interrupted')
        throw new Error('錄音同步至磁碟失敗，已保留可讀取的部分，請釋放空間後檢查原始錄音');
      return result;
    } finally {
      this.active = false;
      this.pc?.close();
      for (const s of this.sources) s.getTracks().forEach((t) => t.stop());
      if (this.context.state !== 'closed') await this.context.close().catch(() => {});
      this.stopping = false;
      this.asrActive = false;
      this.paused = false;
      this.rid = null;
    }
  }
}
