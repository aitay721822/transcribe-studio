import { useState } from 'react';
import type { Project, UiState } from '../../domain/models';
import { icon } from '../components/icons';

export function ProjectSidebarRow({
  state,
  project: p,
  archived = false,
}: {
  state: UiState;
  project: Project;
  archived?: boolean;
}) {
  const key = `studio.project.${p.id}.collapsed`;
  const [collapsed, setCollapsed] = useState<boolean | undefined>(() => {
    const saved = localStorage.getItem(key);
    if (saved === 'true') {
      return true;
    }
    if (saved === 'false') {
      return false;
    }
    return undefined;
  });
  const expanded = !archived && !(collapsed ?? p.id !== state.projectId);
  const childrenId = `project-meetings-${p.id}`;
  const meetings = state.meetings.filter((m) => m.projectId === p.id).slice(0, 6);
  return (
    <>
      <div className={`project-sidebar-row ${p.id === state.projectId ? 'selected' : ''}`}>
        {!archived && (
          <button
            type="button"
            className="project-toggle"
            data-project-toggle={p.id}
            aria-label={`${expanded ? '收合' : '展開'} ${p.name}`}
            aria-expanded={expanded}
            aria-controls={childrenId}
            title={expanded ? '收合專案' : '展開專案'}
            onClick={(event) => {
              event.stopPropagation();
              localStorage.setItem(key, String(expanded));
              setCollapsed(expanded);
            }}
          >
            {icon('down')}
          </button>
        )}
        <button
          className={`project-button ${p.id === state.projectId ? 'selected' : ''}`}
          data-project={p.id}
          title={p.name}
        >
          {icon('folder')}
          <span className="project-name">{p.name}</span>
          {p.pinned ? icon('pin', 'project-pin') : ''}
        </button>
        <div className="project-row-actions">
          <button
            data-project-menu={p.id}
            aria-label={`${p.name} 的專案選單`}
            aria-haspopup="menu"
            aria-expanded="false"
          >
            {icon('more')}
          </button>
          <button data-project-edit={p.id} aria-label={`編輯 ${p.name}`}>
            {icon('edit')}
          </button>
        </div>
      </div>
      {!archived && (
        <div
          id={childrenId}
          className="project-children"
          data-expanded={expanded}
          aria-hidden={!expanded}
          inert={!expanded}
        >
          <div className="project-children-inner">
            <div className="project-sub">
              {meetings.map((m) => (
                <button
                  className={
                    'meeting-link ' +
                    (m.id === state.meetingId && state.view === 'workspace' ? 'active' : '')
                  }
                  data-meeting={m.id}
                  key={m.id}
                >
                  {m.title}
                </button>
              ))}
              {!meetings.length && <div className="meeting-link">尚無會議紀錄</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
