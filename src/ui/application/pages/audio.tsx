import type { ReactNode } from 'react';
import type { Meeting } from '../../../domain/models';
import { AUDIO_FILE_LIMIT_LABEL } from '../../../domain/transcription';
import { LiveDevicePicker } from '../../audio/devices/live';
import { AudioJobs, DenoiseOption } from '../../audio/processing/progress';
import { btn, heading } from '../../components/display';
import { icon } from '../../components/icons';
import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import { Select } from '../../primitives/select';
import type { PageContext } from './contracts';

export function audioViews(
  context: PageContext,
  meetingsTable: (meetings: Meeting[]) => ReactNode
) {
  const { state, capture, project, current } = context;

  function livePage() {
    const fileMode = state.audioSourceMode === 'file';
    return (
      <div className="content">
        {heading('LIVE SESSION', '即時會議', '選擇裝置音量或音訊檔案，開始整理會議。')}
        <div className="source-tabs">
          <Button
            variant="outline"
            className={`btn ${!fileMode ? 'active' : ''}`}
            data-audio-mode="device"
          >
            {icon('mic')}裝置音量
          </Button>
          <Button
            variant="outline"
            className={`btn ${fileMode ? 'active' : ''}`}
            data-audio-mode="file"
          >
            {icon('file')}音訊檔案
          </Button>
        </div>
        {fileMode ? (
          <section className="panel">
            <h2>音訊檔案</h2>
            <Button variant="ghost" size="bare" className="dropzone" data-action="pick-files">
              {icon('upload')}
              <strong>選擇音訊檔案</strong>
              <small>
                WAV · MP3 · M4A · FLAC · WEBM · OGG ｜{' '}
                <span className="file-limit">單檔上限 {AUDIO_FILE_LIMIT_LABEL}</span>
              </small>
            </Button>
            <div className="field">
              <label htmlFor="import-project">存入專案</label>
              <Select id="import-project">
                {state.projects
                  .filter((p) => !p.archivedAt)
                  .map((p, __index) => (
                    <option value={p.id} data-selected={p.id === state.projectId} key={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            </div>
            {state.selectedFiles.map((f, __index) => (
              <div className="selected-file" key={f.id}>
                {icon('file')}
                <div>
                  {f.name}
                  <small>{(f.size / 1024 / 1024).toFixed(2)} MB</small>
                </div>
                <Button variant="ghost" size="bare" data-remove-file={f.id} aria-label="移除檔案">
                  {icon('x')}
                </Button>
              </div>
            ))}
            <p className="help">
              音檔會自動轉檔，優先在停頓處分段，每段最多 30
              秒；連續說話時保留重疊音訊，完成後可在工作台編輯。
            </p>
            <DenoiseOption state={state} />
            <AudioJobs state={state} />
            {btn('開始辨識', 'transcribe-files', 'wave', 'primary')}
          </section>
        ) : (
          <div className="split-page">
            <section className="panel">
              <h2>音訊來源</h2>
              <LiveDevicePicker state={state} busy={capture.active || capture.starting} />
              <label className="check-line">
                <Checkbox
                  id="record-only"
                  defaultChecked={state.recordOnly}
                  onCheckedChange={(checked) => {
                    state.recordOnly = checked === true;
                  }}
                />
                只錄音，會後再辨識
              </label>
              <div className="button-row">
                {btn('測試音量', 'test-audio', 'wave')}
                {btn('說話辨識測試', 'test-asr-connection', 'mic')}
                {btn('開始會議', 'new-meeting', 'mic', 'primary')}
              </div>
            </section>
            <section className="panel">
              <h2>會議前的準備</h2>
              <div className="field">
                <label htmlFor="live-project">目前專案</label>
                <Select id="live-project">
                  {state.projects
                    .filter((p) => !p.archivedAt)
                    .map((p, __index) => (
                      <option value={p.id} data-selected={state.projectId === p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </div>
              <p className="help">
                開始前可測試選定裝置。音訊與逐字稿會同步保留，辨識連線失敗時仍持續本地錄音。
              </p>
            </section>
          </div>
        )}
      </div>
    );
  }

  function importPage() {
    return (
      <div className="content">
        {heading('FROM AUDIO TO CONTEXT', '音檔辨識', '匯入錄音或逐字稿，接續整理會議紀錄。')}
        <div className="split-page">
          <section className="panel">
            <h2>匯入檔案</h2>
            <Button variant="ghost" size="bare" className="dropzone" data-action="pick-files">
              {icon('upload')}
              <strong>選擇音檔或逐字稿</strong>
              <small>
                WAV · MP3 · M4A · FLAC · WEBM · OGG ｜{' '}
                <span className="file-limit">單檔上限 {AUDIO_FILE_LIMIT_LABEL}</span>
                <br />
                TXT · SRT · VTT ｜ <span className="file-limit">單檔上限 25 MB</span>
              </small>
            </Button>
            <div className="field">
              <label>存入專案</label>
              <Select id="import-project">
                {state.projects.map((p, __index) => (
                  <option value={p.id} data-selected={p.id === state.projectId} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            {state.selectedFiles.map((f, __index) => (
              <div className="selected-file" key={f.id}>
                {icon('file')}
                <div>
                  {f.name}
                  <small>{(f.size / 1024 / 1024).toFixed(2)} MB</small>
                </div>
                <Button variant="ghost" size="bare" data-remove-file={f.id} aria-label="移除檔案">
                  {icon('x')}
                </Button>
              </div>
            ))}
            <p className="help">
              音檔會自動轉檔，優先在停頓處分段，連續說話時保留重疊音訊；TXT／SRT／VTT
              可直接匯入，不需要 API key。
            </p>
            <DenoiseOption state={state} />
            {btn('開始辨識', 'transcribe-files', 'wave', 'primary')}
          </section>
          <section>
            <AudioJobs state={state} />
            <div className="section-heading">
              <h2>匯入紀錄</h2>
              <span>{state.meetings.filter((m) => m.source === 'file').length} 筆</span>
            </div>
            {meetingsTable(state.meetings.filter((m) => m.source === 'file'))}
          </section>
        </div>
      </div>
    );
  }

  return {
    livePage,
    importPage,
  };
}
