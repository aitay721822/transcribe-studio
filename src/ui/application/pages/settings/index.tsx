import { btn } from '../../../components/display';
import type { PageContext } from '../contracts';
import { agentSettings } from './agent';
import { asrSettings } from './asr';
import { appearanceSettings, extensionsSettings } from './extensions';

export function settingsViews(context: PageContext) {
  const { state } = context;

  function settingsPage() {
    const s = state.settings;
    const c = s.asr;
    let body;
    if (state.settingsTab === 'asr') body = asrSettings(context);
    else if (state.settingsTab === 'agent') body = agentSettings(context);
    else if (state.settingsTab === 'mcp') body = extensionsSettings(context);
    else body = appearanceSettings(context);
    return (
      <div className="settings-page">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="設定分類">
            {[
              ['asr', '語音辨識'],
              ['agent', 'Agent 模型'],
              ['mcp', 'MCP 與 Skills'],
              ['appearance', '外觀'],
            ].map(([tab, label], __index) => (
              <button
                data-settings-tab={tab}
                className={state.settingsTab === tab ? 'active' : ''}
                aria-current={state.settingsTab === tab ? 'page' : undefined}
                key={tab}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <div className="settings-scroll">{body}</div>
            <footer className="settings-actions">
              {btn('重新開啟設定導覽', 'setup', '', 'text')}
              {btn('儲存設定', 'save-settings', 'check', 'primary')}
            </footer>
          </div>
        </div>
      </div>
    );
  }

  return {
    settingsPage,
  };
}
