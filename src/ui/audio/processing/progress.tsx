import type { UiState } from '../../../domain/models';
import { invalidateUI } from '../../layout/roots';
import { Checkbox } from '../../primitives/checkbox';
import { TaskPanel } from '../tasks/panel';

export function DenoiseOption({ state }: { state: UiState }) {
  return (
    <label className="audio-denoise-option">
      <Checkbox
        data-audio-denoise
        checked={state.audioDenoise !== false}
        onCheckedChange={(checked) => {
          state.audioDenoise = checked === true;
          localStorage.setItem('studio.audio-denoise', String(state.audioDenoise));
          invalidateUI();
        }}
      />
      <span>
        <strong>辨識前降低背景雜音</strong>
        <small>溫和降低低頻雜音與持續底噪；原始音檔會保留。</small>
      </span>
    </label>
  );
}

export function AudioJobs({ state, meetingId }: { state: UiState; meetingId?: string }) {
  return (
    <TaskPanel
      key={meetingId || state.projectId || 'all'}
      state={state}
      meetingId={meetingId}
      compact
    />
  );
}
