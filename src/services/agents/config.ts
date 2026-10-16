import os from 'node:os';
import path from 'node:path';
import { agentAuth } from '../../domain/agents/auth';
import type { LlmSettings } from '../../domain/models';

export function agentHome(
  llm: LlmSettings,
  id: 'codex' | 'claude',
  runtime: string,
  project: string
) {
  if (agentAuth(llm, id) === 'api') return path.join(runtime, 'projects', project, `${id}-home`);
  return path.resolve(
    process.env[id === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] ||
      path.join(os.homedir(), `.${id}`)
  );
}

export function agentEnv(llm: LlmSettings, id: 'codex' | 'claude', home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (agentAuth(llm, id) === 'api') {
    if (id === 'codex') {
      env['CODEX_HOME'] = home;
      env['STUDIO_CODEX_API_KEY'] = llm.apiKey;
      delete env['CODEX_ACCESS_TOKEN'];
    } else {
      env['CLAUDE_CONFIG_DIR'] = home;
      env['ANTHROPIC_API_KEY'] = llm.claudeKey;
      env['ANTHROPIC_BASE_URL'] = 'https://api.anthropic.com';
      for (const key of [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
      ])
        delete env[key];
    }
  }
  // A desktop app may have been launched by another Claude process.
  if (id === 'claude') delete env['CLAUDECODE'];
  return env;
}

/** Explicitly turn off developer integrations, while letting Codex own authentication. */
export const codexArgs = [
  'app-server',
  '--listen',
  'stdio://',
  ...['shell_tool', 'unified_exec', 'apps', 'remote_plugin', 'multi_agent', 'hooks'].flatMap(
    (name) => ['-c', `features.${name}=false`]
  ),
];
