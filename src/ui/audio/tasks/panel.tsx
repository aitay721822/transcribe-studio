import { useEffect, useState } from 'react';
import type { TaskAction, TaskFilter } from '../../../domain/asr/tasks';
import type { UiState } from '../../../domain/models';
import { duration } from '../../components/display';
import { Button } from '../../primitives/button';
import { TaskCard } from './card';
import { ConnectionPanel } from './connections';
import { useTaskClock, useTaskList } from './data';
import { TaskFilters } from './filters';

export function AutoRecoveryToggle({ meetingId }: { meetingId: string }) {
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window.studio
      .invoke('asr:auto-recovery', meetingId)
      .then((value) => {
        if (alive) setEnabled(value);
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : '無法取得補辨識設定');
      });
    return () => {
      alive = false;
    };
  }, [meetingId]);
  return (
    <div>
      <label className="check-line">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            const next = event.target.checked;
            void window.studio
              .invoke('asr:auto-recovery', meetingId, next)
              .then(setEnabled)
              .catch((error: unknown) =>
                setError(error instanceof Error ? error.message : '設定失敗')
              );
          }}
        />
        自動建立斷線補辨識任務
      </label>
      <p className="help">停用後不新增補辨識任務；現有任務可在下方另行取消或刪除。</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function TaskPanel({
  state,
  meetingId,
  projectId,
  compact = false,
}: {
  state: UiState;
  meetingId?: string;
  projectId?: string;
  compact?: boolean;
}) {
  const selectedProjectId =
    projectId ||
    state.meetings.find((meeting) => meeting.id === meetingId)?.projectId ||
    state.projectId ||
    undefined;
  const [filter, setFilter] = useState<TaskFilter>({
    meetingId,
    projectId: selectedProjectId,
    limit: compact ? 5 : 10,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { page, error, refresh } = useTaskList(filter);
  const now = useTaskClock();

  async function run(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await operation();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失敗，請重新嘗試');
    } finally {
      setBusy(false);
    }
  }

  function act(ids: string[], action: TaskAction | 'reassign') {
    void run(async () => {
      if (action === 'reassign') await window.studio.invoke('asr:reassign', ids);
      else await window.studio.invoke('asr:task-action', ids, action);
      setSelected(new Set());
    });
  }

  const visibleSelected = page?.items.filter((task) => selected.has(task.id)) || [];
  const selectedSeconds = visibleSelected.reduce(
    (sum, task) => sum + Math.max(0, task.end - task.start - task.completedSeconds),
    0
  );
  const selectedMeeting = meetingId || filter.meetingId;
  return (
    <section className={`asr-task-panel ${compact ? 'compact' : ''}`} aria-label="辨識任務">
      <div className="asr-task-heading">
        <div>
          <h2>辨識任務</h2>
          <p className="help">
            {page ? `${page.total} 個任務` : '正在讀取任務…'} · 原始錄音獨立保留
          </p>
        </div>
        {compact ? (
          <Button variant="outline" className="btn small" data-task-project={selectedProjectId}>
            管理此專案任務
          </Button>
        ) : (
          <Button
            variant="outline"
            className="btn small"
            disabled={busy || !page}
            onClick={() =>
              void run(() => window.studio.invoke('asr:background', !page?.backgroundPaused))
            }
          >
            {page?.backgroundPaused ? '繼續背景任務' : '暫停全部背景任務'}
          </Button>
        )}
      </div>
      {!compact && (
        <TaskFilters
          state={state}
          filter={filter}
          change={(next) => {
            setFilter({ ...next, projectId: selectedProjectId });
            setSelected(new Set());
          }}
        />
      )}
      {page?.backgroundPaused && (
        <p role="status" className="notice">
          背景任務已暫停；錄音與即時辨識繼續。
        </p>
      )}
      {selectedMeeting && <AutoRecoveryToggle key={selectedMeeting} meetingId={selectedMeeting} />}
      <ConnectionPanel state={state} meetingId={selectedMeeting} projectId={filter.projectId} />
      <p className="help">
        關閉程式後任務會保留，重新開啟後繼續；人工暫停與取消的任務不會自動恢復。
      </p>
      {page && page.items.length > 0 && (
        <div className="asr-task-bulk">
          <label className="check-line">
            <input
              type="checkbox"
              aria-label="選取本頁全部任務"
              checked={page.items.every((task) => selected.has(task.id))}
              onChange={(event) =>
                setSelected(new Set(event.target.checked ? page.items.map((task) => task.id) : []))
              }
            />
            本頁全選
          </label>
          {visibleSelected.length > 0 && (
            <>
              <span>
                已選 {visibleSelected.length} 個任務 ·{' '}
                {new Set(visibleSelected.map((task) => task.meetingId)).size} 場會議 ·{' '}
                {duration(selectedSeconds)}
              </span>
              {(['pause', 'resume', 'retry', 'cancel', 'delete'] as const).map((action) => (
                <Button
                  key={action}
                  variant="ghost"
                  className="btn text small"
                  disabled={busy}
                  onClick={() =>
                    act(
                      visibleSelected.map((task) => task.id),
                      action
                    )
                  }
                >
                  {
                    {
                      pause: '批次暫停',
                      resume: '批次繼續',
                      retry: '批次重試',
                      cancel: '批次取消',
                      delete: '批次刪除',
                    }[action]
                  }
                </Button>
              ))}
            </>
          )}
        </div>
      )}
      {(error || message) && (
        <p role="alert" className="error">
          {error || message}
        </p>
      )}
      {page?.items.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          context={`${state.projects.find((project) => project.id === task.projectId)?.name || '專案'} · 錄音 ${Math.max(1, (state.meetings.find((meeting) => meeting.id === task.meetingId)?.recordings.findIndex((recording) => recording.id === task.recordingId) ?? 0) + 1)}`}
          now={now}
          selected={selected.has(task.id)}
          busy={busy}
          select={(checked) =>
            setSelected((previous) => {
              const next = new Set(previous);
              if (checked) next.add(task.id);
              else next.delete(task.id);
              return next;
            })
          }
          act={(action) => act([task.id], action)}
        />
      ))}
      {page?.total === 0 && <div className="asr-task-empty">目前沒有符合的辨識任務。</div>}
      {page && (
        <div className="asr-task-pagination">
          <Button
            variant="outline"
            className="btn small"
            disabled={busy || page.offset === 0}
            onClick={() => {
              setFilter({ ...filter, offset: Math.max(0, page.offset - (filter.limit || 10)) });
              setSelected(new Set());
            }}
          >
            上一頁
          </Button>
          <span>
            {page.total ? page.offset + 1 : 0}–{page.offset + page.items.length} / {page.total}
          </span>
          <Button
            variant="outline"
            className="btn small"
            disabled={busy || page.nextOffset === null}
            onClick={() => {
              if (page.nextOffset !== null) setFilter({ ...filter, offset: page.nextOffset });
              setSelected(new Set());
            }}
          >
            下一頁
          </Button>
        </div>
      )}
    </section>
  );
}
