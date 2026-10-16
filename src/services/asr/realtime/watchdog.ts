import type { AsrEvent } from '../../../domain/asr/config';

/** Only submitted voiced turns can time out; out-of-order finals cannot clear a different turn. */
export class ResponseWatchdog {
  private pending = new Map<number, { end: number; since: number }>();
  private voice = false;
  private since = 0;

  constructor(private manualCommits: boolean) {}

  audio(voiced: boolean, now: number): void {
    if (!voiced) return;
    this.voice = true;
    if (!this.manualCommits && !this.since) this.since = now;
  }

  receive(event: AsrEvent, now: number): void {
    if (event.type === 'audio-committed' && event.coverage) {
      if (this.voice)
        this.pending.set(event.coverage.start, { end: event.coverage.end, since: now });
      this.voice = false;
    }
    if (!event.segment) return;
    if (!event.segment.final) {
      if (!this.manualCommits && this.since) this.since = now;
      return;
    }
    const range = event.coverage;
    if (range) {
      for (const [start, value] of this.pending)
        if (start >= range.start && value.end <= range.end) this.pending.delete(start);
    }
    if (!this.manualCommits) this.since = 0;
  }

  stalled(now: number): boolean {
    if (this.since && now - this.since >= 30000) return true;
    return [...this.pending.values()].some((value) => now - value.since >= 30000);
  }

  reset(): void {
    this.pending.clear();
    this.voice = false;
    this.since = 0;
  }
}
