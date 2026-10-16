import { cleanDeviceName } from '../../../domain/audio-devices';
import type { ConnectionEvent, Invoke } from '../../../domain/ipc';
import type { Settings } from '../../../domain/models';
import { AudioHealth } from '../lifecycle/health';
import { openAudioSources } from '../sources';
import { connectTestRtc } from './rtc';

type Api = Invoke;
export class SpeechConnectionTest {
  readonly id = crypto.randomUUID();
  private controller = new AbortController();
  private streams: MediaStream[] = [];
  private context?: AudioContext;
  private pc?: RTCPeerConnection;
  private worklet?: AudioWorkletNode;
  private queue = Promise.resolve();
  private pending = 0;
  private running = false;
  private stopping?: Promise<void>;
  private startedRemote = false;
  private flushed?: () => void;

  constructor(
    private api: Api,
    private event: (event: ConnectionEvent) => void
  ) {}

  async start(settings: Settings, source: string, device: string) {
    try {
      this.streams = await openAudioSources(source, device);
      this.controller.signal.throwIfAborted();
      const track = this.streams.at(-1)?.getAudioTracks()[0];
      if (source !== 'system' && track)
        this.event({
          type: 'device',
          label: cleanDeviceName(track.label),
          sampleRate: track.getSettings().sampleRate,
          channelCount: track.getSettings().channelCount,
        });
      this.event({ type: 'status', message: '裝置已開啟，正在連接辨識服務…' });
      this.startedRemote = true;
      const config = await this.api('connection:asr-start', this.id, settings);
      if (this.controller.signal.aborted) {
        await this.api('connection:stop', this.id, false);
        this.controller.signal.throwIfAborted();
      }
      this.context = new AudioContext();
      const mix = this.context.createGain();
      mix.gain.value = source === 'both' ? 0.5 : 1;
      for (const stream of this.streams)
        this.context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(mix);
      await this.context.audioWorklet.addModule('./audio/pcm-worklet.js');
      this.controller.signal.throwIfAborted();
      this.worklet = new AudioWorkletNode(this.context, 'studio-pcm', {
        processorOptions: { rate: config.sampleRate },
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
      });
      const silent = this.context.createGain();
      silent.gain.value = 0;
      mix.connect(this.worklet).connect(silent).connect(this.context.destination);
      this.running = true;
      const health =
        source === 'mic'
          ? undefined
          : new AudioHealth((message) => this.event({ type: 'status', message }));
      let voice = false,
        lastVoice = 0,
        lastCommit = Date.now();
      this.worklet.port.onmessage = ({ data }) => {
        if (data.flushed) {
          this.flushed?.();
          return;
        }
        if (!this.running) return;
        if ('level' in data) {
          health?.sample(
            data.level,
            this.streams[0]?.getAudioTracks().some((track) => track.muted)
          );
          this.event({ type: 'level', level: data.level });
          if (data.level > 0.012) {
            voice = true;
            lastVoice = Date.now();
          }
          if (
            config.provider === 'openai' &&
            voice &&
            (Date.now() - lastVoice > 900 || Date.now() - lastCommit > 10000)
          ) {
            voice = false;
            lastCommit = Date.now();
            this.queue = this.queue
              .then(() => this.api('connection:asr-commit', this.id))
              .catch((e) => this.fail(e.message));
          }
        }
        if (data.audio && config.provider !== 'webrtc') {
          if (this.pending >= 30) {
            this.fail('音訊傳送壅塞，請重新測試');
            return;
          }
          this.pending++;
          this.queue = this.queue
            .then(async () => {
              if (!(await this.api('connection:asr-audio', this.id, data.audio)))
                throw new Error('辨識串流已中斷');
            })
            .catch((e) => this.fail(e.message))
            .finally(() => this.pending--);
        }
      };
      await this.context.resume();
      if (config.provider === 'webrtc') {
        const destination = this.context.createMediaStreamDestination();
        mix.connect(destination);
        this.pc = await connectTestRtc(
          this.id,
          config,
          destination.stream,
          this.api,
          this.controller.signal,
          (message) => this.fail(message)
        );
      }
      this.controller.signal.throwIfAborted();
      this.streams.forEach((stream) =>
        stream.getAudioTracks().forEach((track) => {
          track.onended = () => this.fail('所選音訊裝置已結束');
        })
      );
      this.event({
        type: 'ready',
        connected: config.provider !== 'transcriptions',
        message:
          config.provider === 'transcriptions'
            ? `裝置已就緒，請說話；每 ${config.chunkSeconds} 秒上傳一段，收到文字後確認辨識連線。`
            : '已連線，請說話，辨識文字會顯示在下方。',
      });
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      await this.stop(false);
      await this.release();
      throw e;
    }
  }

  private fail(message: string) {
    if (this.controller.signal.aborted) return;
    this.event({ type: 'error', message });
    void this.stop(false);
  }

  stop(graceful = true): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!graceful) {
      this.running = false;
      this.controller.abort(new Error('測試已結束'));
    }
    this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    this.stopping = (async () => {
      try {
        if (graceful && this.running && this.worklet && this.context?.state === 'running')
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            this.flushed = () => {
              clearTimeout(timer);
              resolve();
            };
            this.worklet.port.postMessage({ flush: true });
          });
        this.running = false;
        this.worklet?.disconnect();
        await this.queue;
        if (this.startedRemote) await this.api('connection:stop', this.id, graceful);
      } finally {
        this.controller.abort(new Error('測試已結束'));
        await this.release();
      }
    })();
    return this.stopping;
  }

  private async release() {
    this.pc?.close();
    this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
