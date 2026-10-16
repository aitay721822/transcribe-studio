import type { Meeting } from '../../../domain/models';
import { badge, btn, date, duration, empty, heading, statusLabel } from '../../components/display';
import { icon } from '../../components/icons';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { Select } from '../../primitives/select';
import { ProjectOverview } from '../../projects/overview';
import type { PageContext } from './contracts';

export function libraryViews(context: PageContext) {
  const { state, capture, project, current } = context;

  function meetingsTable(meetings: Meeting[]) {
    if (!meetings.length)
      return empty(
        '還沒有會議紀錄',
        '從即時錄音開始，或匯入一段音訊，讓重要的討論留下來。',
        btn('建立第一場會議', 'new-meeting', 'plus', 'primary')
      );
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>會議名稱</th>
              <th>時長</th>
              <th>狀態</th>
              <th>更新時間</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {meetings.map((m, __index) => (
              <tr className="meeting-row" data-meeting={m.id} key={m.id}>
                <td>
                  <span className="file-tile">{icon(m.source === 'live' ? 'mic' : 'file')}</span>
                  <div>
                    <strong>{m.title}</strong>
                    <small>
                      {state.projects.find((p) => p.id === m.projectId)?.name} ·{' '}
                      {m.source === 'live' ? '即時會議' : '音檔辨識'}
                    </small>
                  </div>
                </td>
                <td>{duration(m.duration)}</td>
                <td>{badge(m.status)}</td>
                <td>{date(m.updatedAt)}</td>
                <td>
                  <div className="meeting-row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="btn text small"
                      data-delete-meeting={m.id}
                      aria-label={`刪除 ${m.title}`}
                      title="刪除會議"
                    >
                      {icon('trash')}
                    </Button>
                    {icon('arrow')}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function overview() {
    const today = new Date().toLocaleDateString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
    return (
      <div className="content">
        {heading(
          'YOUR MEETING SPACE',
          '每段討論，都有脈絡。',
          today,
          <>
            {btn('匯入音檔', 'go-import', 'upload')}
            {btn('開始會議', 'new-meeting', 'plus', 'primary')}
          </>
        )}
        <div className="hero">
          <div className="hero-text">
            <div className="page-eyebrow">A LITTLE MORE PRESENT</div>
            <h2>專心對話，讓紀錄跟上。</h2>
            <p>擷取會議音訊，串連專案資料。從逐字稿到決議與待辦，讓每個想法都有清楚的下一步。</p>
            <div className="button-row">
              {btn('即時會議', 'go-live', 'mic', 'primary')}
              {btn('設定辨識服務', 'go-settings', 'settings', 'text')}
            </div>
          </div>
          <div className="hero-visual">
            <svg
              width="230"
              height="100"
              viewBox="0 0 230 100"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {Array.from(
                {
                  length: 37,
                },
                (_, i) => {
                  const h = 8 + Math.abs(Math.sin(i * 1.37) * Math.sin(i / 9)) * 78;
                  return <path key={i} d={`M${8 + i * 6} ${50 - h / 2}v${h}`} />;
                }
              )}
            </svg>
          </div>
        </div>
        <div className="stats">
          {[
            ['會議紀錄', state.meetings.length, '讓討論成為可追溯的紀錄', 'file'],
            [
              '進行中的會議',
              state.meetings.filter((m) => m.status === 'recording').length,
              '音訊與逐字稿同步保存',
              'mic',
            ],
            ['專案總覽', state.projects.length, '多個資料夾，一個專案', 'folder'],
            [
              '已撰寫紀錄',
              state.meetings.filter((m) => m.notes).length,
              '從對話走向具體行動',
              'sparkle',
            ],
          ].map(([label, n, sub, ic], __index) => (
            <div className="stat" key={label}>
              <div className="stat-label">
                {label}
                {icon(String(ic))}
              </div>
              <strong>{n.toString().padStart(2, '0')}</strong>
              <small>{sub}</small>
            </div>
          ))}
        </div>
        <div className="section-heading">
          <h2>最近的會議</h2>
          {btn('查看全部', 'go-meetings', 'arrow', 'text small')}
        </div>
        {meetingsTable(state.meetings.slice(0, 6))}
        <div className="footer-note">
          音訊與文件儲存在這台電腦。使用辨識或 Agent 時，選定內容會傳送至你設定的服務。
        </div>
      </div>
    );
  }

  function meetingsPage() {
    const filtered = state.meetings.filter(
      (m) =>
        (!state.filter ||
          `${m.title}${m.notes}${m.segments.map((s, __index) => s.text).join(' ')}`
            .toLowerCase()
            .includes(state.filter.toLowerCase())) &&
        (!state.statusFilter || m.status === state.statusFilter)
    );
    return (
      <div className="content">
        {heading(
          'MEETING LIBRARY',
          '所有會議',
          '找回討論的脈絡，接續未完成的想法。',
          btn('新增會議', 'new-meeting', 'plus', 'primary')
        )}
        <div className="filters">
          <Input
            id="meeting-search"
            placeholder="搜尋會議名稱、逐字稿或紀錄…"
            aria-label="搜尋會議"
            defaultValue={state.filter}
          />
          <Select id="status-filter" aria-label="篩選狀態">
            <option value="">全部狀態</option>
            {Object.entries(statusLabel).map(([v, l], __index) => (
              <option value={v} data-selected={state.statusFilter === v} key={v}>
                {l}
              </option>
            ))}
          </Select>
          <span className="help">{filtered.length} 場會議</span>
        </div>
        <div id="meeting-results">{meetingsTable(filtered)}</div>
      </div>
    );
  }

  function projectPage() {
    const p = project();
    if (!p)
      return (
        <div className="content">
          {empty(
            '建立你的第一個專案',
            '將會議、參考文件與紀錄放在同一個工作區。',
            btn('新增專案', 'new-project', 'plus', 'primary')
          )}
        </div>
      );
    return (
      <div className="content">
        {heading(
          'PROJECT OVERVIEW',
          p.name,
          p.archivedAt
            ? '此專案已封存，既有會議與文件仍保留。'
            : '讓每場會議，都能參考專案的既有脈絡。',
          <>
            {btn('編輯專案', 'rename-project', 'file')}
            {btn(p.archivedAt ? '解除封存' : '封存專案', 'archive-project', 'folder')}

            {btn('刪除專案', 'delete-project', 'x', 'danger')}

            {btn('加入資料夾', 'add-folder', 'plus', 'primary')}
          </>
        )}
        <ProjectOverview key={p.id} project={p} state={state} table={meetingsTable} />
      </div>
    );
  }

  return {
    meetingsTable,
    overview,
    meetingsPage,
    projectPage,
  };
}
