import type { LlmSettings } from '../models';

export type AuthMode = 'cli' | 'api';

/** Missing mode is a legacy setting: preserve configured API access. */
export function agentAuth(llm: LlmSettings, backend = llm.backend): AuthMode {
  if (backend === 'codex') return llm.codexAuth || (llm.apiKey?.trim() ? 'api' : 'cli');
  if (backend === 'claude') return llm.claudeAuth || (llm.claudeKey?.trim() ? 'api' : 'cli');
  return 'api';
}

export function agentModel(llm: LlmSettings, backend = llm.backend): string {
  const configuredModel = () => {
    if (backend === 'claude') {
      return llm.claudeModel;
    }
    if (backend === 'codex' && agentAuth(llm, backend) === 'cli') {
      return llm.codexModel;
    }
    return llm.model;
  };

  return configuredModel()?.trim() || '';
}
