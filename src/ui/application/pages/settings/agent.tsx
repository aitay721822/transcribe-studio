import { compressionSettings } from '../../../../domain/agents/compression';
import { executionLimits } from '../../../../domain/agents/limits';
import { AgentConfiguration } from '../../../agent/configuration';
import { btn } from '../../../components/display';
import { icon } from '../../../components/icons';
import { Checkbox } from '../../../primitives/checkbox';
import { Select } from '../../../primitives/select';
import type { PageContext } from '../contracts';
import { field } from './field';

export function agentSettings(context: PageContext) {
  const { state } = context;
  const s = state.settings,
    c = s.asr;
  const limits = executionLimits(s.llm);
  const compact = compressionSettings(s.llm);
  return (
    <section className="panel">
      <h2>Agent 後端</h2>
      <div className="connection-actions">
        {btn('Agent 模型連線測試', 'test-agent-connection', 'link')}
      </div>
      <div className="field">
        <label htmlFor="llm-backend">Agent 類型</label>
        <Select id="llm-backend">
          {[
            ['openai', 'OpenAI API'],
            ['codex', 'Codex'],
            ['claude', 'Claude Code'],
          ].map(([id, label], __index) => (
            <option value={id} data-selected={(s.llm.backend || 'openai') === id} key={id}>
              {label}
            </option>
          ))}
        </Select>
        <small>各後端共用會議工具、MCP、Skills 與修訂提案流程。</small>
      </div>
      <AgentConfiguration llm={s.llm} />
      {field(
        '模型回合上限',
        'llm-steps',
        limits.maxSteps,
        'number',
        '1–10,000。限制 OpenAI 模型請求與 Claude turns；Codex 使用自己的模型回合，由下方時間與工具上限控制整體執行。'
      )}
      {field(
        '工具呼叫上限',
        'llm-tools',
        limits.maxToolCalls,
        'number',
        '0–10,000 次；0 表示不限。適用所有後端，與模型回合數分開計算。'
      )}
      {field(
        '每次執行時間上限（分鐘）',
        'llm-timeout',
        limits.timeoutMinutes,
        'number',
        '0–1,440 分鐘；0 表示不限。預設 30 分鐘，可隨時手動停止。儲存後於下一次執行生效。'
      )}
      <div className="notice">
        <label className="check-line">
          <Checkbox id="llm-auto-compact" defaultChecked={compact.autoCompact} />
          自動壓縮上下文
        </label>
        <p>
          OpenAI
          執行中與各後端下一輪開始時自動整理。原始工具紀錄保留；摘要請求計入模型回合與執行時間。Codex／Claude
          執行中的壓縮由 CLI 管理。
        </p>
      </div>
      {field(
        '自動壓縮門檻（字元）',
        'llm-compact-threshold',
        compact.compactThreshold,
        'number',
        '12,000–1,000,000；預設 60,000。依序列化上下文字元計算，並非模型 token 數。可隨時使用 /compact 手動壓縮。'
      )}
      <div className="notice">
        {icon('book')}Agent 只產生修訂提案。你可以比較原稿與新稿，再套用變更。
      </div>
    </section>
  );
}
