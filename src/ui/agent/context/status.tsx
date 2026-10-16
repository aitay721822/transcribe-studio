import type { AgentEvent } from '../../../domain/models';
import { Disclosure, DisclosureTrigger } from '../../primitives/disclosure';

export function CompactionStatus({ event }: { event: AgentEvent }) {
  const sizes = event.args as { beforeChars?: number; afterChars?: number };

  const compactionIndicator = () => {
    if (event.status === 'running') {
      return '◌ ';
    }
    if (event.status === 'completed') {
      return '✓ ';
    }
    return '⚠ ';
  };

  return (
    <Disclosure className={`compaction-card ${event.status || ''}`}>
      <DisclosureTrigger>
        {compactionIndicator()}
        {event.message}
      </DisclosureTrigger>
      {sizes?.beforeChars != null && (
        <p>
          {sizes.beforeChars.toLocaleString()} 字元
          {sizes.afterChars != null ? ` → ${sizes.afterChars.toLocaleString()} 字元` : ''}
        </p>
      )}
      <pre>
        {JSON.stringify(
          {
            status: event.status,
            timestamp: event.timestamp,
            durationMs: event.durationMs,
            args: event.args,
            output: event.result,
          },
          null,
          2
        )}
      </pre>
    </Disclosure>
  );
}
