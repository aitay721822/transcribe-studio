declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processor: new (options: { processorOptions: { rate: number } }) => AudioWorkletProcessor
): void;

class PCMProcessor extends AudioWorkletProcessor {
  targetRate: number;
  phase: number;
  pending: number[];
  buffer: Int16Array;
  pos: number;
  counter: number;

  constructor(options: { processorOptions: { rate: number } }) {
    super();
    this.targetRate = options.processorOptions.rate;
    this.phase = 0;
    this.pending = [];
    this.buffer = new Int16Array(Math.round(this.targetRate / 10));
    this.pos = 0;
    this.counter = 0;
    this.port.onmessage = ({ data }) => {
      if (!data?.flush) return;
      if (this.pos) {
        const bytes = this.buffer.slice(0, this.pos).buffer;
        this.port.postMessage({ audio: bytes }, [bytes]);
        this.pos = 0;
      }
      this.port.postMessage({ flushed: true });
    };
  }

  process(inputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let power = 0;
    for (const v of input) {
      this.pending.push(v);
      power += v * v;
    }
    const step = sampleRate / this.targetRate;
    while (this.phase + 1 < this.pending.length) {
      const index = Math.floor(this.phase),
        frac = this.phase - index;
      const v = Math.max(
        -1,
        Math.min(1, this.pending[index] * (1 - frac) + this.pending[index + 1] * frac)
      );
      this.buffer[this.pos++] = Math.round(v * (v < 0 ? 32768 : 32767));
      this.phase += step;
      if (this.pos === this.buffer.length) {
        const bytes = this.buffer.buffer;
        this.port.postMessage({ audio: bytes }, [bytes]);
        this.buffer = new Int16Array(Math.round(this.targetRate / 10));
        this.pos = 0;
      }
    }
    const consumed = Math.floor(this.phase);
    this.pending.splice(0, consumed);
    this.phase -= consumed;
    if (++this.counter % 12 === 0)
      this.port.postMessage({ level: Math.sqrt(power / input.length) });
    return true;
  }
}
registerProcessor('studio-pcm', PCMProcessor);
