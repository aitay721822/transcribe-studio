declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
}

declare function registerProcessor(name: string, processor: typeof PlaybackProcessor): void;

class PlaybackProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = [];
  private offset = 0;
  private buffered = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!(event.data instanceof Float32Array)) return;
      // Bound latency when the renderer was suspended or its consumer fell behind.
      if (this.buffered + event.data.length > sampleRate / 2) {
        this.queue = [];
        this.offset = 0;
        this.buffered = 0;
      }
      this.queue.push(event.data);
      this.buffered += event.data.length;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    for (let index = 0; index < output.length; index++) {
      const chunk = this.queue[0];
      if (!chunk) break;
      output[index] = chunk[this.offset++];
      this.buffered--;
      if (this.offset === chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('studio-playback', PlaybackProcessor);

export {};
