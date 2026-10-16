import { useEffect, useState } from 'react';
import type { AsrConnectionStatus, ConnectionAction } from '../../../domain/asr/connection';
import type { UiState } from '../../../domain/models';
import { Button } from '../../primitives/button';
import { useTaskClock } from './data';

const labels: Record<AsrConnectionStatus['state'], string> = {
  connecting: '正在連線',
  connected: '即時辨識已連線',
  waiting_retry: '等待重新連線',
  needs_attention: '連線設定需要處理',
  paused: '即時連線已暫停',
  closed: '即時辨識已結束',
};

export function ConnectionPanel({
  state,
  meetingId,
  projectId,
}: {
  state: UiState;
  meetingId?: string;
  projectId?: string;
}) {
  const [connections, setConnections] = useState<AsrConnectionStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const now = useTaskClock();
  useEffect(() => {
    let alive = true;
    const unsubscribe = window.studio.on('asr:connection', (value) => {
      if (alive)
        setConnections((all) => [
          ...all.filter((item) => item.recordingId !== value.recordingId),
          value,
        ]);
    });
    void window.studio
      .invoke('asr:connections')
      .then((values) => {
        if (alive) setConnections(values);
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : '無法取得即時連線狀態');
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  async function act(id: string, action: ConnectionAction) {
    setBusy(true);
    try {
      await window.studio.invoke('asr:connection-action', id, action);
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '連線操作失敗');
    } finally {
      setBusy(false);
    }
  }

  const visible = connections.filter(
    (connection) =>
      connection.state !== 'closed' &&
      (!meetingId || connection.meetingId === meetingId) &&
      (!projectId ||
        state.meetings.some(
          (meeting) => meeting.id === connection.meetingId && meeting.projectId === projectId
        ))
  );
  if (!visible.length && !error) return null;
  return (
    <section className="asr-connections" aria-label="即時辨識連線">
      {visible.map((connection) => (
        <article
          key={connection.recordingId}
          className="asr-task-card"
          data-connection-state={connection.state}
        >
          <div className="asr-task-title">
            <strong>
              {state.meetings.find((meeting) => meeting.id === connection.meetingId)?.title ||
                '目前會議'}
            </strong>
            <span className="asr-task-state">{labels[connection.state]}</span>
          </div>
          <p role="status">
            {connection.state === 'waiting_retry'
              ? `${Math.max(0, Math.ceil((connection.nextAttemptAt - now) / 1000))} 秒後重連 · 已嘗試 ${connection.attempts} 次`
              : `已嘗試 ${connection.attempts} 次`}
          </p>
          {connection.error && <p className="asr-task-error">{connection.error.message}</p>}
          <p className="help">連線失敗時錄音仍持續；背景補辨識任務可在下方另外管理。</p>
          <div className="asr-task-actions">
            {connection.state === 'paused' ? (
              <Button
                className="btn small"
                variant="outline"
                disabled={busy}
                onClick={() => void act(connection.meetingId, 'resume')}
              >
                繼續即時連線
              </Button>
            ) : (
              <Button
                className="btn small"
                variant="outline"
                disabled={busy}
                onClick={() => void act(connection.meetingId, 'pause')}
              >
                暫停即時連線
              </Button>
            )}
            {['waiting_retry', 'needs_attention'].includes(connection.state) && (
              <Button
                className="btn small"
                variant="outline"
                disabled={busy}
                onClick={() => void act(connection.meetingId, 'retry')}
              >
                立即重連
              </Button>
            )}
            {connection.state === 'needs_attention' && (
              <>
                <Button
                  className="btn small"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act(connection.meetingId, 'reconfigure')}
                >
                  改用目前設定並重連
                </Button>
                <Button className="btn text small" variant="ghost" data-view="settings">
                  前往設定
                </Button>
              </>
            )}
          </div>
        </article>
      ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
