import type { InputState } from '../ipc';
import { record } from '../value';

export function isInputState(value: unknown): value is InputState {
  const input = record(value);
  return (
    (input.activeRunId === null || typeof input.activeRunId === 'string') &&
    typeof input.paused === 'boolean' &&
    Array.isArray(input.queued) &&
    (input.queued as unknown[]).every((value) => {
      const item = record(value);
      return typeof item.id === 'string' && typeof item.instruction === 'string';
    })
  );
}
