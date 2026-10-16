import type { ReactNode } from 'react';
import type { Meeting, Project, UiState } from '../../domain/models';
import { shortcutLabel } from '../application/platform/shortcuts';
import { icon } from '../components/icons';
import { Button } from '../primitives/button';

export function projectOverview(
  project: Project,
  state: UiState,
  table: (meetings: Meeting[]) => ReactNode
) {
  const meetings = state.meetings
    .filter((meeting) => meeting.projectId === project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const disabled = project.archivedAt ? 'disabled' : '';
  const stats = [
    ['會議紀錄', meetings.length, 'file'],
    [
      '進行中',
      meetings.filter((meeting) => ['recording', 'transcribing'].includes(meeting.status)).length,
      'wave',
    ],
    ['已撰寫紀錄', meetings.filter((meeting) => meeting.notes.trim()).length, 'edit'],
    ['參考資料夾', project.roots.length, 'folder'],
  ] as const;
  return (
    <section className="project-overview" aria-labelledby="project-overview-heading">
      <div className="project-overview-heading">
        <h2 id="project-overview-heading">總覽</h2>
        <div className="project-meeting-shortcuts">
          <Button
            variant="outline"
            className="btn"
            data-action="project-live"
            disabled={Boolean(disabled)}
          >
            {icon('mic')}即時會議<kbd>{shortcutLabel('M', true)}</kbd>
          </Button>
          <Button
            variant="outline"
            className="btn"
            data-action="project-import"
            disabled={Boolean(disabled)}
          >
            {icon('upload')}音檔辨識<kbd>{shortcutLabel('I', true)}</kbd>
          </Button>
        </div>
      </div>
      {project.archivedAt ? <p className="help">解除封存後，即可在此專案開始新會議。</p> : ''}
      <div className="project-overview-stats">
        {stats.map(([label, count, glyph], __index) => (
          <div className="project-overview-stat" key={label}>
            <div>
              {icon(glyph)}
              <span>{label}</span>
            </div>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <div className="section-heading">
        <h2>會議紀錄</h2>
        <span className="help">{meetings.length} 場 · 此專案</span>
      </div>
      {meetings.length ? (
        table(meetings)
      ) : (
        <div className="project-meetings-empty">
          尚無會議。從「即時會議」開始錄音，或選擇「音檔辨識」匯入錄音。
        </div>
      )}
    </section>
  );
}
