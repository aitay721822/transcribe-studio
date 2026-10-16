import type { Invoke, IpcCommands } from '../../../domain/ipc';
import type { UiState } from '../../../domain/models';

type Overrides = {
  [K in keyof IpcCommands]?: (
    ...args: Parameters<IpcCommands[K]>
  ) => Promise<Awaited<ReturnType<IpcCommands[K]>>>;
};

/** Preserve each command's argument/result pairing when routing a temporary chat. */
export function sessionApi(state: UiState, api: Invoke): Invoke {
  const overrides: Overrides = {
    'meeting:update': (id, patch, version, scope) => {
      const temporary = state.temporaryChat;
      if (temporary && patch.annotations && !('notes' in patch))
        return api('agent:temporary-annotations', temporary.id, id, patch.annotations, version);
      if (temporary && (scope || (patch.annotations && 'notes' in patch)))
        return api('agent:temporary-apply', temporary.id, id, patch, version, scope);
      return api('meeting:update', id, patch, version, scope);
    },

    'agent:input-state': (id, sessionId) =>
      api('agent:input-state', id, state.temporaryChat?.id || sessionId),

    'agent:trace': (id, sessionId) => api('agent:trace', id, state.temporaryChat?.id || sessionId),

    'agent:resume': (id, sessionId) =>
      api('agent:resume', id, state.temporaryChat?.id || sessionId),

    'agent:command': (id, command, sessionId) =>
      api('agent:command', id, command, state.temporaryChat?.id || sessionId),

    'agent:promote': (id, runId, sessionId) =>
      api('agent:promote', id, runId, state.temporaryChat?.id || sessionId),

    'agent:run': (request) =>
      api('agent:run', { ...request, sessionId: state.temporaryChat?.id || request.sessionId }),

    'agent:submit': (request, mode, runId) =>
      api(
        'agent:submit',
        { ...request, sessionId: state.temporaryChat?.id || request.sessionId },
        mode,
        runId
      ),
  };
  return <K extends keyof IpcCommands>(name: K, ...args: Parameters<IpcCommands[K]>) => {
    const invoke = overrides[name];
    return invoke ? invoke(...args) : api(name, ...args);
  };
}
