import { useEffect, useState } from 'react';
import { agentAuth, agentModel } from '../../domain/agents/auth';
import type { LlmSettings } from '../../domain/models';
import type { DetectedAgent } from '../../services/agents/detection';
import { Button } from '../primitives/button';
import { Input } from '../primitives/input';
import { Select } from '../primitives/select';

export function AgentFields({
  llm,
  prefix = '',
  agents = [],
}: {
  llm: LlmSettings;
  prefix?: string;
  agents?: DetectedAgent[];
}) {
  const backend = llm.backend || 'openai',
    local = ['codex', 'claude'].includes(backend);
  const mode = agentAuth(llm);

  const field = (
    label: string,
    name: string,
    value = '',
    hint = '',
    type = 'text',
    list?: string
  ) => (
    <div className="field" key={name}>
      <label htmlFor={`${prefix}${name}`}>{label}</label>
      <Input
        id={`${prefix}${name}`}
        defaultValue={value}
        type={type}
        autoComplete="off"
        list={list}
      />
      {hint && <small>{hint}</small>}
    </div>
  );

  const modelField = () => {
    if (backend === 'claude') {
      return 'claude-model';
    }
    if (backend === 'codex' && mode === 'cli') {
      return 'codex-cli-model';
    }
    return 'llm-model';
  };

  return (
    <div key={`${backend}:${mode}`}>
      {local && (
        <div className="field">
          <label htmlFor={`${prefix}${backend}-auth`}>認證方式</label>
          <Select id={`${prefix}${backend}-auth`}>
            <option value="cli" data-selected={mode === 'cli'}>
              沿用 CLI 登入
            </option>
            <option value="api" data-selected={mode === 'api'}>
              自行設定 API key
            </option>
          </Select>
          <small>
            {mode === 'cli' ? '由本機 CLI 管理登入與憑證更新。' : '使用 Studio 儲存的 API 設定。'}
          </small>
        </div>
      )}
      {mode === 'api' &&
        (backend === 'claude' ? (
          field('Anthropic API key', 'claude-key', llm.claudeKey, '', 'password')
        ) : (
          <>
            {field('API Base URL', 'llm-url', llm.baseUrl, '', 'url')}
            {field('API key', 'llm-key', llm.apiKey, '', 'password')}
          </>
        ))}
      {field(
        mode === 'cli' ? '模型（選填）' : '模型名稱',
        modelField(),
        agentModel(llm),
        mode === 'cli' ? '留白沿用 CLI 的模型設定。' : '',
        'text',
        `${prefix}agent-models`
      )}
      <datalist id={`${prefix}agent-models`}>
        {agents
          .find((agent) => agent.id === backend)
          ?.login?.models?.map((model) => (
            <option value={model.id} key={model.id}>
              {model.name}
            </option>
          ))}
      </datalist>
      {local &&
        field(
          backend === 'codex' ? 'Codex CLI 路徑（選填）' : 'Claude Code CLI 路徑（選填）',
          prefix ? 'cli-path' : `${backend}-path`,
          backend === 'codex' ? llm.codexPath : llm.claudePath,
          '請先安裝 CLI；留白自動尋找本機安裝，或指定執行檔路徑。'
        )}
      {local && mode === 'cli' && (
        <p className="help">
          尚未登入時，請在終端機執行 {backend === 'codex' ? 'codex login' : 'claude auth login'}
          ，再重新偵測。
        </p>
      )}
    </div>
  );
}

export function AgentConfiguration({ llm }: { llm: LlmSettings }) {
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const backend = llm.backend;
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError('');
    setAgents([]);
    window.studio
      .invoke('agents:detect', llm)
      .then((result) => {
        if (alive) setAgents(result);
      })
      .catch(() => {
        if (alive) setError('偵測失敗，請重新偵測或執行連線測試。');
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [backend, llm.codexAuth, llm.claudeAuth]);

  async function detect() {
    if (busy) return;
    setBusy(true);
    setError('');
    const input = document.getElementById(`${backend}-path`) as HTMLInputElement;
    try {
      setAgents(
        await window.studio.invoke('agents:detect', {
          ...llm,
          ...(input ? { [`${backend}Path`]: input.value.trim() } : {}),
        })
      );
    } catch {
      setError('偵測失敗，請重新偵測或執行連線測試。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AgentFields llm={llm} agents={agents} />
      {['codex', 'claude'].includes(backend) && (
        <div className="connection-actions">
          <p role="status">
            {busy
              ? '正在偵測 CLI 登入…'
              : error || agents.find((agent) => agent.id === backend)?.detail}
          </p>
          <Button variant="outline" onClick={detect} disabled={busy}>
            重新偵測 CLI
          </Button>
        </div>
      )}
    </>
  );
}
