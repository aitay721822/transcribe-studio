import { THEMES } from '../../../../domain/themes';
import { icon } from '../../../components/icons';
import { Button } from '../../../primitives/button';
import type { PageContext } from '../contracts';
import { field } from './field';

export function extensionsSettings(context: PageContext) {
  const { state } = context;
  const s = state.settings,
    c = s.asr;
  return (
    <>
      <section className="panel">
        <h2>MCP 工具接入</h2>
        {field(
          '伺服器設定（JSON 陣列）',
          'mcp-config',
          JSON.stringify(s.mcp, null, 2),
          'textarea',
          '支援 stdio 與 Streamable HTTP。連線與每次工具呼叫都會在 Agent 面板要求確認。'
        )}
        <p className="help">stdio 範例：</p>
        <pre className="code-field">
          {JSON.stringify(
            [
              {
                name: 'my-server',
                transport: 'stdio',
                command: 'node',
                args: ['C:/tools/server.js'],
                enabled: true,
              },
            ],
            null,
            2
          )}
        </pre>
        <p className="help">HTTP 範例：</p>
        <pre className="code-field">
          {JSON.stringify(
            [
              {
                name: 'remote',
                transport: 'http',
                url: 'http://localhost:3000/mcp',
                enabled: true,
              },
            ],
            null,
            2
          )}
        </pre>
      </section>
      <section className="panel settings-section">
        <h2>Skills</h2>
        <p className="help">
          自動發現各專案資料夾的 .agents/skills/*/SKILL.md 與 .codex/skills/*/SKILL.md。Agent
          可按需載入，或在對話輸入框旁指定。
        </p>
        {state.skills.map((sk, __index) => (
          <div className="project-root" key={sk.id}>
            {icon('book')}
            <div>
              <strong>{sk.name}</strong>
              <small>{sk.description}</small>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

export function appearanceSettings(context: PageContext) {
  const { state } = context;
  const s = state.settings,
    c = s.asr;
  return (
    <section className="panel">
      <h2>外觀主題</h2>
      <div className="theme-options">
        {THEMES.map(({ id, label, description }) => (
          <Button
            variant="ghost"
            size="bare"
            className={`theme-option ${s.theme === id ? 'active' : ''}`}
            data-theme-option={id}
            aria-pressed={s.theme === id}
            key={id}
          >
            <span className={`theme-swatch ${id}`} data-theme={id} aria-hidden="true">
              <span className="theme-preview-sidebar" />
              <span className="theme-preview-document">
                <span />
                <span />
                <span />
              </span>
            </span>
            <span className="theme-option-label">
              {label}
              {s.theme === id && icon('check')}
            </span>
            <span className="theme-option-description">{description}</span>
          </Button>
        ))}
      </div>
      <div className="footer-note">
        側邊欄與頂列使用半透明模糊效果。Windows 使用原生 acrylic 材質；效果依作業系統設定而異。
      </div>
    </section>
  );
}
