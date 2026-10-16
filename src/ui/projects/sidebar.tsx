import { Fragment } from 'react';
import type { Project, UiState } from '../../domain/models';
import { icon } from '../components/icons';
import { ProjectSidebarRow } from './row';

export function projectSidebar(state: UiState) {
  const row = (p: Project, archived = false) => (
    <ProjectSidebarRow state={state} project={p} archived={archived} />
  );

  const pinned = state.projects.filter((p) => !p.archivedAt && p.pinned);
  const active = state.projects.filter((p) => !p.archivedAt && !p.pinned);
  const sections = ['', ...new Set(active.map((p, __index) => p.section || '').filter(Boolean))];
  const groups = sections.map((section, __index) => {
    const projects = active.filter((p) => (p.section || '') === section);
    return (
      <Fragment key={__index}>
        {section ? <div className="sidebar-section-label">{section}</div> : ''}
        {projects.map((p, __index) => (
          <Fragment key={p.id}>{row(p)}</Fragment>
        ))}
      </Fragment>
    );
  });
  const selected = state.projects.find((p) => p.id === state.projectId);
  return (
    <>
      <div className="project-list">
        {pinned.length ? (
          <section className="pinned-projects" aria-label="已釘選專案">
            <div className="sidebar-label pinned-projects-heading">已釘選</div>
            {pinned.map((p, __index) => (
              <Fragment key={p.id}>{row(p)}</Fragment>
            ))}
          </section>
        ) : (
          ''
        )}
        <div className="sidebar-label">
          <button
            className="project-heading-menu"
            data-project-menu={selected?.id || ''}
            aria-label="專案下拉選單"
            aria-haspopup="menu"
            aria-expanded="false"
          >
            專案 {icon('down')}
          </button>
          <button aria-label="新增專案" data-action="new-project">
            {icon('plus')}
          </button>
        </div>
        <div className="regular-projects">
          {groups ||
            (!pinned.length ? (
              <div className="help">建立專案，將會議與參考資料放在一起。</div>
            ) : (
              ''
            ))}
        </div>
      </div>
      <details className="archived-projects" open={!!selected?.archivedAt}>
        <summary>已封存專案（{state.projects.filter((p) => p.archivedAt).length}）</summary>
        {state.projects
          .filter((p) => p.archivedAt)
          .map((p, __index) => (
            <Fragment key={p.id}>{row(p, true)}</Fragment>
          ))}
      </details>
    </>
  );
}
