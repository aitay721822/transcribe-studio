import { agentAuth } from '../../domain/agents/auth';
import type { LlmSettings } from '../../domain/models';
import { credentialRedactor } from '../security/redaction';
import { executableCandidates } from './executable';
import { captureCli, type LoginState, probeLogin } from './login';

export interface DetectedAgent {
  id: 'codex' | 'claude';
  name: string;
  installed: boolean;
  runnable: boolean;
  path: string;
  version: string;
  configured: boolean;
  detail: string;
  login?: LoginState;
}

export async function probeVersion(file: string, timeout = 4000): Promise<string> {
  const result = await captureCli(file, ['--version'], timeout);
  if (result.code !== 0 || !result.output.trim()) throw new Error('CLI 無法啟動');
  if (result.output.length > 8192) throw new Error('版本輸出過大');
  return result.output.trim().split(/\r?\n/)[0].slice(0, 200);
}

/** Ask each CLI about authentication; never read or import credential files. */
export async function detectAgents(llm: LlmSettings): Promise<DetectedAgent[]> {
  return Promise.all(
    (['codex', 'claude'] as const).map(async (id) => {
      const files = await executableCandidates(id, id === 'codex' ? llm.codexPath : llm.claudePath);
      const result: DetectedAgent = {
        id,
        name: id === 'codex' ? 'Codex' : 'Claude Code',
        installed: !!files.length,
        runnable: false,
        path: files[0] || '',
        version: '',
        configured:
          agentAuth(llm, id) === 'cli' ||
          !!(id === 'codex' ? llm.apiKey && llm.model : llm.claudeKey && llm.claudeModel),
        detail: files.length ? '已找到 CLI，尚未確認版本' : '未偵測到本機 CLI',
      };
      for (const file of files.slice(0, 3)) {
        try {
          result.version = await probeVersion(file);
          result.path = file;
          result.runnable = true;
          result.login = await probeLogin(id, file);

          const authenticationDetail = () => {
            if (agentAuth(llm, id) === 'cli') {
              return result.login.detail;
            }
            if (result.configured) {
              return '已設定 API 模式';
            }
            return '請設定 API key 與模型，或切換沿用 CLI 登入';
          };

          result.detail = authenticationDetail();
          break;
        } catch (caughtError) {
          const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

          result.detail = credentialRedactor({ llm }).text(error.message);
        }
      }
      return result;
    })
  );
}
