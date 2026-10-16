import type { ServiceHealth } from '../../domain/asr/tasks';
import type { TaskStorage } from './storage';

export function blockServiceTasks(storage: TaskStorage, health: ServiceHealth): void {
  if (!health.error) return;
  const state = health.error.scope === 'none' ? 'needs_attention' : 'waiting_retry';
  storage.db
    .prepare(`UPDATE asr_tasks SET state=?,next_at=?,data=json_set(data,'$.state',?,
    '$.nextAttemptAt',?,'$.error',json(?)) WHERE service_id=? AND deleted=0
    AND state IN ('queued','waiting_retry') AND COALESCE(json_extract(data,'$.deferred'),0)=0`)
    .run(
      state,
      health.nextAttemptAt,
      state,
      health.nextAttemptAt,
      JSON.stringify(health.error),
      health.id
    );
}

export function restoreServiceTasks(storage: TaskStorage, serviceId: string, now: number): void {
  storage.db
    .prepare(`UPDATE asr_tasks SET state='queued',next_at=?,data=json_remove(json_set(data,
    '$.state','queued','$.nextAttemptAt',?),'$.error') WHERE service_id=? AND deleted=0
    AND state='waiting_retry' AND json_extract(data,'$.error.scope')='service'`)
    .run(now, now, serviceId);
}

export function expediteService(storage: TaskStorage, serviceId: string, now: number): void {
  const health = storage.health(serviceId);
  if (health.error?.scope !== 'service') return;
  health.nextAttemptAt = Math.max(now, health.notBefore);
  storage.saveHealth(health);
  storage.db
    .prepare(`UPDATE asr_tasks SET next_at=?,data=json_set(data,'$.nextAttemptAt',?)
    WHERE service_id=? AND state='waiting_retry' AND json_extract(data,'$.error.scope')='service'`)
    .run(health.nextAttemptAt, health.nextAttemptAt, serviceId);
}
