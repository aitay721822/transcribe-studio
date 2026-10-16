/** PCM16 pause detection, independent of packet sizes and wall-clock delivery delays. */
export class SpeechBoundary {
  private frameSamples = 0;
  private power = 0;
  private samples = 0;
  private silence = 0;
  private voiced = false;

  constructor(private rate: number) {}

  /** Consume through the first pause boundary, or consume the whole supplied packet. */
  consume(bytes: Buffer): number {
    const frameSize = Math.round(this.rate * 0.02);
    for (let offset = 0; offset < bytes.length; offset += 2) {
      this.power += (bytes.readInt16LE(offset) / 32768) ** 2;
      this.frameSamples++;
      this.samples++;
      if (this.frameSamples < frameSize) continue;
      if (Math.sqrt(this.power / this.frameSamples) > 0.012) {
        this.voiced = true;
        this.silence = 0;
      } else {
        this.silence += this.frameSamples;
      }
      this.frameSamples = 0;
      this.power = 0;
      if (this.voiced && this.samples >= this.rate && this.silence >= this.rate * 0.9)
        return offset + 2;
    }
    return bytes.length;
  }

  reached(): boolean {
    return this.voiced && this.samples >= this.rate && this.silence >= this.rate * 0.9;
  }

  reset(): void {
    this.frameSamples = 0;
    this.power = 0;
    this.samples = 0;
    this.silence = 0;
    this.voiced = false;
  }
}
