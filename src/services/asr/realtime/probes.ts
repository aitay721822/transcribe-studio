import type { AsrRepository } from '../../../persistence/asr/repository';

const probes = new WeakMap<AsrRepository, Set<string>>();

export function acquireProbe(
  repository: AsrRepository,
  serviceId: string
): (() => void) | undefined {
  let active = probes.get(repository);
  if (!active) {
    active = new Set();
    probes.set(repository, active);
  }
  if (active.has(serviceId)) return undefined;
  active.add(serviceId);
  return () => active.delete(serviceId);
}
