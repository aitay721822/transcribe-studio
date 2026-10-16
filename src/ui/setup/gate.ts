import { agentAuth } from '../../domain/agents/auth';
import type { Invoke } from '../../domain/ipc';
import type { Settings, UiState } from '../../domain/models';
import { setupReadiness } from '../../domain/readiness';

/** Installation checks supplement the persisted service configuration, never form drafts. */
export function createSetupGate(state: UiState, api: Invoke) {
  let revision = 0;
  return async (settings: Settings = state.settings): Promise<boolean> => {
    const request = ++revision;
    if (!setupReadiness(settings).complete) {
      state.setupLocked = true;
      return false;
    }
    // Keep a usable workspace open while rechecking CLI paths after saving settings.
    // Startup is already locked; an incomplete configuration locks immediately above.
    const runnable =
      !['codex', 'claude'].includes(settings.llm.backend) ||
      (settings.llm.backend === 'claude' && agentAuth(settings.llm) === 'api') ||
      (await api('agents:detect')).some(
        (agent) => agent.id === settings.llm.backend && agent.runnable
      );
    if (request !== revision) return false;
    state.setupLocked = !runnable;
    return runnable;
  };
}
