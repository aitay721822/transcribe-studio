import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRun } from '../domain/models';

export class ApprovalQueue {
  private pending = new Map<string, (accepted: boolean) => void>();

  constructor(private emit: (event: AgentEvent) => void) {}

  answer(id: string, accepted: boolean): void {
    this.pending.get(id)?.(accepted);
  }

  confirm(
    run: AgentRun,
    name: string,
    args: unknown,
    signal: AbortSignal,
    record?: (event: AgentEvent) => void
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const id = randomUUID();

      const done = (accepted: boolean) => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        this.pending.delete(id);
        record?.({ type: 'approval-decision', id, name, accepted });
        resolve(accepted);
      };

      const aborted = () => done(false);

      const timer = setTimeout(aborted, 120000);
      this.pending.set(id, done);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) done(false);
      else
        (record || this.emit)({
          type: 'approval',
          id,
          runId: run.id,
          meetingId: run.meetingId,
          name,
          args,
        });
    });
  }
}
