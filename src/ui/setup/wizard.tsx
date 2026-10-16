import { type ReactNode, useEffect, useRef, useState } from 'react';
import { agentAuth } from '../../domain/agents/auth';
import type { Invoke } from '../../domain/ipc';
import type { Settings } from '../../domain/models';
import { setupReadiness } from '../../domain/readiness';
import type { DetectedAgent } from '../../services/agents/detection';
import { AgentFields } from '../agent/configuration';
import { SpeechServices } from '../audio/configuration/services';
import { closeDropdown } from '../components/dropdown';
import { Reveal } from '../components/motion/reveal';
import { Button } from '../primitives/button';
import { Select } from '../primitives/select';

interface SetupHost {
  api: Invoke;
  saved(settings: Settings): void | Promise<void>;
  finish(): void | Promise<void>;
  test(settings: Settings, kind: 'asr' | 'agent'): void;
}
export interface SetupProps {
  settings: Settings;
  host: SetupHost;
}

export function SetupWizard({ settings, host }: SetupProps) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [step, setStep] = useState(() => (setupReadiness(settings).asr ? 1 : 0));
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true),
    lock = useRef(false),
    detectingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (step === 1 && !detected) void detect();
  }, [step]);

  async function detect() {
    if (detectingRef.current) return;
    detectingRef.current = true;
    setDetecting(true);
    try {
      collect();
      const result = await host.api('agents:detect', draft.llm);
      if (alive.current) {
        setAgents(result);
        setDetected(true);
      }
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current) setError(e.message);
    } finally {
      detectingRef.current = false;
      if (alive.current) setDetecting(false);
    }
  }

  async function guarded(fn: () => void | Promise<void>) {
    if (lock.current) return;
    setError('');
    try {
      await fn();
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current) setError(e.message);
    }
  }

  async function next() {
    collect();
    const ready = setupReadiness(draft);
    if ((step === 0 || step === 2) && !ready.offline)
      throw new Error('請先完成必填的離線辨識設定：HTTP 端點、模型及服務所需的驗證');
    if (step === 0 && !ready.asr)
      throw new Error('請完成已啟用的即時辨識設定，或關閉即時辨識後繼續');
    if (
      (step === 0 && !ready.asr) ||
      (step === 1 && !ready.agent) ||
      (step === 2 && !ready.complete)
    )
      throw new Error('請填妥服務網址、API key 與模型等必要欄位');
    lock.current = true;
    setSaving(true);
    try {
      const saved = await host.api('settings:save', draft);
      if (!alive.current) return;
      setDraft(saved);
      await host.saved(saved);
      if (
        step === 1 &&
        (saved.llm.backend === 'codex' ||
          (saved.llm.backend === 'claude' && agentAuth(saved.llm) === 'cli'))
      ) {
        const found = await host.api('agents:detect');
        if (!alive.current) return;
        setAgents(found);
        if (!found.find((a) => a.id === saved.llm.backend)?.runnable)
          throw new Error(
            `找不到可啟動的 ${saved.llm.backend === 'codex' ? 'Codex' : 'Claude Code'}，請確認 CLI 路徑或選擇其他 Agent`
          );
      }
      if (step === 2) await host.finish();
      else {
        closeDropdown();
        setStep(step + 1);
      }
    } finally {
      lock.current = false;
      if (alive.current) setSaving(false);
    }
  }

  function change(id: string, value: string) {
    collect();
    if (id === 'setup-asr-flavor') draft.asr.realtimeFlavor = value;
    else if (id === 'setup-codex-auth') draft.llm.codexAuth = value as 'cli' | 'api';
    else if (id === 'setup-claude-auth') draft.llm.claudeAuth = value as 'cli' | 'api';
    else draft.llm.backend = value as Settings['llm']['backend'];
    closeDropdown();
    setDraft(structuredClone(draft));
  }

  function useAgent(id: string) {
    collect();
    const agent = agents.find((a) => a.id === id);
    draft.llm.backend = agent.id;
    if (agent.id === 'codex') {
      draft.llm.codexPath = agent.path;
      draft.llm.codexAuth = 'cli';
    } else {
      draft.llm.claudePath = agent.path;
      draft.llm.claudeAuth = 'cli';
    }
    setDraft(structuredClone(draft));
  }

  function detectionView() {
    return (
      <>
        <div className="setup-detection-head">
          <span>{detecting ? '正在偵測本機 Agent…' : '本機 Agent'}</span>
          <Button
            variant="ghost"
            size="sm"
            className="btn text small"
            id="setup-detect"
            disabled={detecting}
          >
            重新偵測
          </Button>
        </div>
        {agents.map((agent, __index) => (
          <div className="detected-agent" key={__index}>
            <div>
              <strong>{agent.name}</strong>
              <small>{`${agent.version ? `${agent.version} · ` : ''}${agent.detail}`}</small>
              {agent.path ? (
                <small className="detected-path" title={agent.path}>
                  {agent.path}
                </small>
              ) : (
                ''
              )}
            </div>
            {agent.runnable ? (
              <Button variant="outline" size="sm" className="btn small" data-setup-agent={agent.id}>
                使用
              </Button>
            ) : (
              <span className="help">{agent.installed ? '無法啟動' : '未安裝'}</span>
            )}
          </div>
        ))}
      </>
    );
  }

  function collect() {
    const value = (id: string) =>
      (document.getElementById(`setup-${id}`) as HTMLInputElement)?.value;

    if (step === 0) {
      const a = draft.asr;
      a.provider = (document.getElementById('setup-asr-realtime-enabled') as HTMLInputElement)
        ?.checked
        ? 'openai'
        : 'transcriptions';
      a.apiKey = value('asr-key') ?? a.apiKey;
      a.fileApiKey = value('asr-file-key') ?? a.fileApiKey;
      a.model = value('asr-model')?.trim();
      a.fileModel = value('asr-file-model')?.trim();
      a.fileUrl = value('asr-file-url')?.trim();
      a.url = value('asr-url')?.trim();
      a.language = value('asr-language')?.trim();
      a.realtimeFlavor = value('asr-flavor');
      a.chunkSeconds = Number(value('asr-chunk-seconds'));
      a.fileHeaders = JSON.parse(value('asr-file-headers') || '{}');
      a.headers = JSON.parse(value('asr-headers') || '{}');
    } else if (step === 1) {
      const l = draft.llm;
      if (l.backend === 'claude') {
        l.claudeKey = value('claude-key') ?? l.claudeKey;
        l.claudeAuth = (value('claude-auth') as 'cli' | 'api') || l.claudeAuth;
        l.claudeModel = value('claude-model')?.trim() ?? l.claudeModel;
        l.claudePath = value('cli-path')?.trim();
      } else {
        l.apiKey = value('llm-key') ?? l.apiKey;
        l.model = value('llm-model')?.trim() ?? l.model;
        l.baseUrl = value('llm-url')?.trim() ?? l.baseUrl;
        l.codexAuth = (value('codex-auth') as 'cli' | 'api') || l.codexAuth;
        l.codexModel = value('codex-cli-model')?.trim() ?? l.codexModel;
        if (l.backend === 'codex') l.codexPath = value('cli-path')?.trim();
      }
    }
  }

  const s = draft;
  const provider = s.asr.provider;
  const backend = s.llm.backend || 'openai';

  const select = (id: string, label: string, options: string[][], selected: string) => (
    <div className="field">
      <label htmlFor={`setup-${id}`}>{label}</label>
      <Select id={`setup-${id}`}>
        {options.map(([value, text], __index) => (
          <option value={value} data-selected={value === selected} key={value}>
            {text}
          </option>
        ))}
      </Select>
    </div>
  );

  const readiness = setupReadiness(s);
  let body: ReactNode = null;
  if (step === 0) {
    body = <SpeechServices config={s.asr} prefix="setup-" wizard />;
  } else if (step === 1) {
    body = (
      <>
        <h2>選擇協助整理的 Agent</h2>
        <p className="help">自動尋找這台電腦的 Codex 與 Claude Code。</p>
        <div id="setup-detection">{detectionView()}</div>
        {select(
          'backend',
          'Agent 後端',
          [
            ['openai', 'OpenAI API'],
            ['codex', 'Codex'],
            ['claude', 'Claude Code'],
          ],
          backend
        )}
        <AgentFields llm={s.llm} prefix="setup-" agents={agents} />
        <p className="help">登入狀態與模型清單由 CLI 提供；模型是否可用請執行連線測試。</p>
      </>
    );
  } else {
    body = (
      <>
        <h2>工作區已準備好</h2>
        <p className="help">設定會保存在這台電腦；API key 透過作業系統加密。</p>
        <div className="setup-summary">
          <div>
            <span>離線辨識（必填）</span>
            <strong>/audio/transcriptions</strong>
            <small>{readiness.offline ? '必要欄位已設定' : '尚未完成'}</small>
            <small>即時辨識：{provider === 'transcriptions' ? '未啟用（選用）' : '已啟用'}</small>
          </div>
          <div>
            <span>Agent</span>
            <strong>
              {
                {
                  openai: 'OpenAI API',
                  codex: 'Codex',
                  claude: 'Claude Code',
                  responses: 'OpenAI API',
                }[backend]
              }
            </strong>
            <small>{readiness.agent ? '必要欄位已設定' : '尚未完成'}</small>
          </div>
        </div>
        <p className="help">
          接著建立專案、加入參考資料夾，即可開始會議。可返回前一步測試辨識服務與模型權限。
        </p>
      </>
    );
  }
  return (
    <div
      className="content setup-page"
      onChange={(event) => {
        const input = event.target as HTMLInputElement;
        if (
          ['setup-backend', 'setup-asr-flavor', 'setup-codex-auth', 'setup-claude-auth'].includes(
            input.id
          )
        )
          void guarded(() => change(input.id, input.value));
      }}
      onClick={(event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button');
        if (!button) return;
        if (button.dataset.setupAgent) void guarded(() => useAgent(button.dataset.setupAgent));
        else
          switch (button.id) {
            case 'setup-back':
              void guarded(() => {
                collect();
                closeDropdown();
                setStep(step - 1);
              });
              break;
            case 'setup-next':
              void guarded(next);
              break;
            case 'setup-detect':
              void detect();
              break;
            case 'setup-test-offline':
            case 'setup-test-realtime':
              void guarded(() => {
                collect();
                const testDraft = structuredClone(draft);
                testDraft.asr.provider =
                  button.id === 'setup-test-offline' ? 'transcriptions' : 'openai';
                host.test(testDraft, 'asr');
              });
              break;
            case 'setup-test':
              void guarded(() => {
                collect();
                host.test(structuredClone(draft), step === 0 ? 'asr' : 'agent');
              });
              break;
          }
      }}
    >
      <section className="setup-wizard" aria-label="初始設定導覽">
        <div className="page-eyebrow">WELCOME TO TRANSCRIBE STUDIO</div>
        <h1>讓第一場會議準備就緒。</h1>
        <ol className="setup-steps">
          {['語音辨識', 'Agent', '完成'].map((label, i) => {
            const stepClass = () => {
              if (i === step) {
                return 'current';
              }
              if (i < step) {
                return 'done';
              }
              return '';
            };

            return (
              <li className={stepClass()} key={i} aria-current={i === step ? 'step' : undefined}>
                <span>{i + 1}</span>
                {label}
              </li>
            );
          })}
        </ol>
        <Reveal className="setup-body" key={`${step}:${backend}:${agentAuth(s.llm)}`}>
          {body}
          {step === 1 && (
            <div className="connection-actions">
              <Button variant="outline" id="setup-test" disabled={saving}>
                Agent 模型連線測試
              </Button>
            </div>
          )}
        </Reveal>
        <p id="setup-error" className="error" role="alert">
          {error}
        </p>
        <footer className="setup-actions">
          <div className="button-row">
            {step ? (
              <Button variant="outline" className="btn" id="setup-back" disabled={saving}>
                上一步
              </Button>
            ) : (
              ''
            )}
            <Button variant="default" className="btn primary" id="setup-next" disabled={saving}>
              {step === 2 ? '進入工作區' : '儲存並繼續'}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
