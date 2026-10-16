import { btn } from '../../components/display';
import { icon } from '../../components/icons';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { projectSidebar } from '../../projects/sidebar';
import type { PageContext } from './contracts';

export function chromeViews(context: PageContext) {
  const { state, capture, project, current } = context;
  const titles: Record<string, string> = {
    overview: '總覽',
    live: '即時會議',
    import: '音檔辨識',
    meetings: '所有會議',
    project: '專案總覽',
    settings: '設定',
    workspace: '會議工作台',
    setup: '設定導覽',
  };

  function sidebar() {
    return (
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">
            <img
              src="./branding/icon.svg"
              alt="Transcribe Studio"
              title="Transcribe Studio"
              width="34"
              height="34"
            />
          </div>
        </div>
        {projectSidebar(state)}
        <div className="sidebar-bottom">
          <button
            className={`nav-button ${state.view === 'settings' ? 'active' : ''}`}
            data-view="settings"
          >
            {icon('settings')}設定
          </button>
        </div>
      </aside>
    );
  }

  function titlebar() {
    return (
      <header className="app-titlebar">
        <button
          className="chrome-button"
          data-action={state.view === 'settings' ? 'back-workspace' : 'collapse-sidebar'}
          aria-label={
            state.view === 'settings'
              ? '返回工作區'
              : `${state.sidebarCollapsed ? '展開' : '收合'}專案側欄`
          }
          title={state.view === 'settings' ? '返回工作區' : '切換專案側欄'}
        >
          {icon(state.view === 'settings' ? 'back' : 'panel')}
        </button>
        <span className="chrome-brand">Transcribe Studio</span>
        <div className="chrome-menu">
          {btn('匯入', 'go-import', '', 'text small')}
          {btn('搜尋', 'search', '', 'text small')}
          {btn('外觀', 'toggle-theme', '', 'text small')}
        </div>
        <div className="top-spacer" />
        <div className="window-controls">
          <button data-window="minimize" aria-label="最小化">
            {icon('minimize')}
          </button>
          <button data-window="maximize" aria-label="最大化">
            {icon('maximize')}
          </button>
          <button data-window="close" aria-label="關閉視窗">
            {icon('x')}
          </button>
        </div>
      </header>
    );
  }

  function topbar() {
    return (
      <header className="topbar">
        <div className="breadcrumb">
          {project() ? (
            <button
              className="breadcrumb-project"
              data-project-menu={project().id}
              aria-label={`${project().name} 的專案下拉選單`}
              aria-haspopup="menu"
              aria-expanded="false"
            >
              {project().name}
              {icon('down')}
            </button>
          ) : (
            <span>個人工作區</span>
          )}
          <span>/</span>
          {state.view === 'workspace' ? (
            <Input
              id="meeting-title"
              key={current()?.id}
              className="meeting-title-input"
              aria-label="會議名稱"
              defaultValue={current()?.title}
            />
          ) : (
            <b>{titles[state.view]}</b>
          )}
        </div>
        <div className="top-spacer" />
        <button className="search-button" data-action="search">
          {icon('search')}搜尋會議<span className="key">Ctrl K</span>
        </button>
        {state.view === 'workspace' ? (
          btn('匯出 Word', 'export', 'download', 'small')
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="btn text small"
            aria-label="切換主題"
            data-action="toggle-theme"
          >
            {icon('sun')}
          </Button>
        )}
      </header>
    );
  }

  return {
    sidebar,
    titlebar,
    topbar,
  };
}
