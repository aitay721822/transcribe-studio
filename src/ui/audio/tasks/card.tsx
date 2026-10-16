import type { AsrTask, TaskAction, TaskSource, TaskState } from '../../../domain/asr/tasks';
import { duration } from '../../components/display';
import { Button } from '../../primitives/button';
import { TaskRanges } from './ranges';

export const taskLabels: Record<TaskState, string> = {
  queued: '等待處理',
  running: '辨識中',
  waiting_retry: '等待重試',
  paused: '已暫停',
  needs_attention: '需要處理',
  completed: '已完成',
  cancelled: '已取消',
};
export const sourceLabels: Record<TaskSource, string> = {
  live: '即時辨識',
  recovery: '斷線補辨識',
  recording: '會後補辨識',
  import: '匯入音檔',
};
const stageLabels: Record<AsrTask['stage'], string> = {
  capture: '正在保存音訊分段',
  decode: '解碼與轉檔',
  denoise: '降低背景雜音',
  segment: '停頓偵測與分段',
  transcribe: '語音辨識',
};

function progressStage(task: AsrTask): string {
  if (task.state === 'needs_attention') return 'failed';
  if (['completed', 'cancelled'].includes(task.state)) return task.state;
  if (task.stage === 'capture') return 'transcribe';
  return task.stage;
}

export function TaskCard({
  task,
  selected,
  select,
  act,
  busy,
  now,
  context,
}: {
  task: AsrTask;
  selected: boolean;
  select(checked: boolean): void;
  act(action: TaskAction | 'reassign'): void;
  busy: boolean;
  now: number;
  context: string;
}) {
  const terminal = ['completed', 'cancelled'].includes(task.state);
  const wait = Math.max(0, Math.ceil((task.nextAttemptAt - now) / 1000));
  const remaining = Math.max(0, task.end - task.start - task.completedSeconds);
  const seconds = duration(remaining);
  return (
    <article
      className="asr-task-card audio-job"
      data-task-id={task.id}
      data-state={task.state}
      data-stage={progressStage(task)}
    >
      <div className="asr-task-title">
        <input
          type="checkbox"
          aria-label={`選取任務 ${task.title}`}
          checked={selected}
          onChange={(event) => select(event.target.checked)}
        />
        <button className="asr-task-meeting" data-meeting={task.meetingId}>
          {task.title}
        </button>
        <span className="asr-task-state" data-state={task.state}>
          {taskLabels[task.state]}
        </span>
      </div>
      <p className="asr-task-meta">
        {context} · {sourceLabels[task.source]} · {duration(task.start)}–{duration(task.end)}
        {['import', 'recording'].includes(task.source) &&
          ` · ${task.denoise ? '已啟用降噪' : '略過降噪'}`}
      </p>
      {!terminal && task.totalChunks > 0 && (
        <progress
          aria-label="辨識分段完成進度"
          value={task.completedChunks}
          max={task.totalChunks}
        />
      )}
      <p className="asr-task-progress">
        已完成 {task.completedChunks} / {task.totalChunks} 段 · 待辨識 {seconds} · 已嘗試{' '}
        {task.attempts} 次
      </p>
      {task.deferred && (
        <p className="help">音訊已保存，等待即時辨識確認；未完成的範圍才會補辨識。</p>
      )}
      {task.unpersistedRanges.length > 0 && (
        <div className="asr-task-error">
          以下音訊未能建立分段，請由原始錄音重新補辨識：
          {task.unpersistedRanges.map((range) => (
            <p key={`${range.start}:${range.end}`}>
              {duration(range.start)}–{duration(range.end)} · {range.message}
            </p>
          ))}
        </div>
      )}
      {task.stage !== 'transcribe' && !terminal && (
        <p className="help">{stageLabels[task.stage]}</p>
      )}
      {task.error && <p className="asr-task-error">{task.error.message}</p>}
      {task.state === 'waiting_retry' && (
        <p role="status" className="asr-task-retry">
          {wait > 0 ? `${wait} 秒後重試` : '等待服務可用後重試'}
          {task.nextAttemptAt > 0 &&
            ` · ${new Date(task.nextAttemptAt).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}`}
        </p>
      )}
      <div className="asr-task-actions">
        {!terminal && task.state !== 'paused' && (
          <Button
            variant="outline"
            className="btn small"
            disabled={busy}
            onClick={() => act('pause')}
          >
            暫停
          </Button>
        )}
        {task.state === 'paused' && !task.reviewRequired && (
          <Button
            variant="outline"
            className="btn small"
            disabled={busy}
            onClick={() => act('resume')}
          >
            繼續
          </Button>
        )}
        {(task.reviewRequired || task.unpersistedRanges.length > 0) && !terminal && (
          <Button
            variant="outline"
            className="btn small"
            data-retranscribe={task.recordingId}
            data-recovery-meeting={task.meetingId}
          >
            從原始錄音選擇補辨識範圍
          </Button>
        )}
        {!task.reviewRequired && ['waiting_retry', 'needs_attention'].includes(task.state) && (
          <Button
            variant="outline"
            className="btn small"
            disabled={busy}
            onClick={() => act('retry')}
          >
            立即重試
          </Button>
        )}
        {task.state === 'needs_attention' && !task.reviewRequired && (
          <>
            <Button
              variant="outline"
              className="btn small"
              disabled={busy}
              onClick={() => act('reassign')}
            >
              改用目前服務並重試
            </Button>
            <Button variant="ghost" className="btn text small" data-view="settings">
              前往設定
            </Button>
          </>
        )}
        {!terminal && (
          <Button
            variant="ghost"
            className="btn text small"
            disabled={busy}
            data-cancel-audio={task.id}
            onClick={(event) => {
              event.stopPropagation();
              act('cancel');
            }}
          >
            取消任務
          </Button>
        )}
        <Button
          variant="ghost"
          className="btn text small"
          disabled={busy}
          onClick={() => act('delete')}
        >
          刪除任務
        </Button>
      </div>
      <TaskRanges task={task} />
    </article>
  );
}
