import { openAudioSources } from './sources';

/** The meter owns capture lifetime; no recording or ASR is started. */
export class VolumeMeter {
  private stopped = false;
  private streams: MediaStream[] = [];
  private context?: AudioContext;
  private frame = 0;

  async start(
    source: string,
    deviceId: string,
    bars: HTMLElement[],
    status: (message: string) => void,
    playbackId = ''
  ): Promise<void> {
    try {
      this.streams = await openAudioSources(source, deviceId, playbackId);
      if (this.stopped) {
        this.stop();
        return;
      }
      for (const stream of this.streams) {
        for (const track of stream.getAudioTracks()) {
          track.onended = () => {
            this.stop();
            status('所選音訊裝置已中斷，請重新選擇裝置');
          };
        }
      }
      this.context = new AudioContext();
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      const gain = this.context.createGain();
      gain.gain.value = source === 'both' ? 0.5 : 1;
      this.streams.forEach((stream) =>
        this.context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(gain)
      );
      gain.connect(analyser);
      const silent = this.context.createGain();
      silent.gain.value = 0;
      analyser.connect(silent).connect(this.context.destination);
      await this.context.resume();
      if (this.stopped) return;
      status('來源已連接，播放聲音或說話以確認音量。');
      const values = new Float32Array(512);
      let previous = 0;
      let level = 0;

      const draw = (now: number) => {
        if (this.stopped) return;
        if (now - previous >= 50) {
          previous = now;
          analyser.getFloatTimeDomainData(values);
          const rms = Math.sqrt(
            values.reduce((sum, sample) => sum + sample * sample, 0) / values.length
          );
          level = Math.max(rms * 5, level * 0.8);
          bars.forEach((bar, index) => {
            bar.style.transform = `scaleY(${Math.max(0.1, Math.min(1, level * (1 - Math.abs(index - bars.length / 2) / bars.length)))})`;
          });
        }
        this.frame = requestAnimationFrame(draw);
      };

      this.frame = requestAnimationFrame(draw);
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      this.stop();
      status(error.message || '無法開啟音訊裝置');
    }
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
  }
}
