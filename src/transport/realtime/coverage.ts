import { record } from '../../domain/value';

interface Range {
  start: number;
  end: number;
}

/** Manual commits are correlated by server item_id; final responses may arrive out of order. */
export class RealtimeCoverage {
  private sent = 0;
  private committed = 0;
  private pending: Range[] = [];
  private items = new Map<string, Range>();

  audio(bytes: number, rate: number): void {
    this.sent += bytes / (rate * 2);
  }

  commit(): Range {
    const range = { start: this.committed, end: this.sent };
    this.pending.push(range);
    this.committed = this.sent;
    return range;
  }

  receive(value: unknown): void {
    const data = record(value);
    if (data.type !== 'input_audio_buffer.committed' || typeof data.item_id !== 'string') return;
    const range = this.pending.shift();
    if (range) this.items.set(data.item_id, range);
  }

  range(id: string): Range | undefined {
    return this.items.get(id);
  }

  all(): Range {
    return { start: 0, end: this.sent };
  }

  finish(id: string): Range | undefined {
    const range = this.items.get(id);
    this.items.delete(id);
    return range;
  }
}
