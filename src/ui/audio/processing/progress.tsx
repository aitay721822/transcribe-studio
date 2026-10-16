import { AUDIO_STAGES, audioJobActive } from '../../../domain/asr/file-progress';
import type { UiState } from '../../../domain/models';
import { duration } from '../../components/display';
import { icon } from '../../components/icons';
import { invalidateUI } from '../../layout/roots';

export function DenoiseOption({ state }: { state: UiState }) {
  return (
    <label className="audio-denoise-option">
      <input
        type="checkbox"
        data-audio-denoise
        checked={state.audioDenoise !== false}
        onChange={(event) => {
          state.audioDenoise = event.currentTarget.checked;
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
  const jobs = (state.audioJobs || [])
    .filter((job) => (meetingId ? job.meetingId === meetingId : job.projectId === state.projectId))
    .sort((a, b) => Number(audioJobActive(b)) - Number(audioJobActive(a)));
  if (!jobs.length) return null;
  return (
    <section className="audio-jobs" aria-label="音訊處理進度">
      {jobs.slice(0, 6).map((job) => {
        const active = audioJobActive(job);
        const stage = AUDIO_STAGES.findIndex(
          (step) =>
            step.id ===
            (job.stage === 'failed' || job.stage === 'cancelled' ? job.lastStage : job.stage)
        );

        const currentStage = () => {
          if (stage >= 0) {
            return stage;
          }
          if (job.stage === 'completed') {
            return AUDIO_STAGES.length;
          }
          return -1;
        };

        const current = currentStage();

        const stageLabel = () => {
          if (job.stage === 'completed') {
            return '辨識完成';
          }
          if (job.stage === 'failed') {
            return '處理失敗';
          }
          if (job.stage === 'cancelled') {
            return '已取消';
          }
          return AUDIO_STAGES[stage]?.label;
        };

        const label = stageLabel();

        const progressLabel = () => {
          if (job.stage === 'transcribe' || job.stage === 'completed') {
            return `已完成 ${job.chunk || 0} / ${job.totalChunks || 0} 段`;
          }
          if (job.seconds !== undefined) {
            return `已處理 ${duration(job.seconds)}`;
          }
          return '';
        };

        return (
          <article className="audio-job" data-stage={job.stage} key={job.id}>
            <div className="audio-job-heading">
              <strong>{job.title}</strong>
              {active && (
                <button className="btn text small" data-cancel-audio={job.id}>
                  取消處理
                </button>
              )}
            </div>
            <ol className="audio-job-steps" aria-label="處理階段">
              {AUDIO_STAGES.map((step, index) => {
                const stageClass = () => {
                  if (index < current) {
                    return 'done';
                  }
                  if (index === current) {
                    if (active) {
                      return 'current';
                    }
                    return 'stopped';
                  }
                  return 'pending';
                };

                return (
                  <li
                    key={step.id}
                    data-state={stageClass()}
                    aria-current={active && index === current ? 'step' : undefined}
                  >
                    <span>{index < current ? icon('check') : index + 1}</span>
                    {step.id === 'denoise' && job.denoise === false ? '略過降噪' : step.label}
                  </li>
                );
              })}
            </ol>
            <div className="audio-job-status" role="status" aria-live="polite">
              <span>
                {job.message || label}
                {active && job.percent !== undefined ? ` · ${Math.floor(job.percent)}%` : ''}
              </span>
              <span>{progressLabel()}</span>
            </div>
            {active && (
              <progress max="100" value={job.percent} aria-label={`${job.title}：${label}`} />
            )}
            {active && <p className="audio-job-hint">正在背景處理，可繼續切換頁面或編輯紀錄。</p>}
          </article>
        );
      })}
    </section>
  );
}
