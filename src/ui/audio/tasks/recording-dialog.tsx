import { useState } from 'react';
import { replacementRange } from '../../../domain/asr/range';
import type { Meeting } from '../../../domain/models';
import { duration } from '../../components/display';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';

export function RecordingTaskDialog({
  meeting,
  recordingId,
  denoise,
  queued,
}: {
  meeting: Meeting;
  recordingId: string;
  denoise: boolean;
  queued(value: Meeting): void;
}) {
  const recording = meeting.recordings.find((value) => value.id === recordingId);
  const offset = recording?.offset || 0;
  const length =
    recording?.duration || (recording?.complete ? Math.max(0, meeting.duration - offset) : 0);
  const [startText, setStart] = useState('0');
  const [endText, setEnd] = useState(length ? String(length) : '');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = Number(startText);
  const end = endText.trim() ? Number(endText) : Number.POSITIVE_INFINITY;
  const valid =
    startText.trim() !== '' &&
    Number.isFinite(start) &&
    start >= 0 &&
    end > start &&
    (Number.isFinite(end) || endText.trim() === '') &&
    (!length || start < length) &&
    (!length || end <= length || endText.trim() === '');
  const range = replacementRange(meeting.segments, recordingId, offset, start, end);
  const aligned = range.start === start && range.end === end;
  const overlaps = range.segments.length > 0;

  async function submit() {
    if (!valid || busy || !aligned || (overlaps && !replace)) return;
    setBusy(true);
    setError('');
    try {
      const value = await window.studio.invoke('recording:transcribe', meeting.id, recordingId, {
        denoise,
        start,
        end: Number.isFinite(end) ? end : undefined,
        replace,
      });
      queued(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : '無法建立補辨識任務');
      setBusy(false);
    }
  }

  return (
    <div className="recording-task-dialog">
      <p>選擇「{meeting.title}」的錄音範圍。任務加入佇列後，可在辨識任務面板暫停或刪除。</p>
      <div className="asr-task-filters">
        <div className="field">
          <label htmlFor="recovery-start">開始時間（秒）</label>
          <Input
            id="recovery-start"
            type="number"
            min="0"
            step="0.1"
            value={startText}
            onChange={(event) => setStart(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="recovery-end">結束時間（秒，留白到結尾）</label>
          <Input
            id="recovery-end"
            type="number"
            min="0"
            step="0.1"
            value={endText}
            onChange={(event) => setEnd(event.target.value)}
          />
        </div>
      </div>
      {valid && (
        <p>
          補辨識範圍：{duration(start)}–{Number.isFinite(end) ? duration(end) : '錄音結尾'}
        </p>
      )}
      {!valid && (
        <p role="alert" className="error">
          請輸入錄音內有效的開始與結束時間。
        </p>
      )}
      {valid && !aligned && (
        <div className="notice">
          <p>此範圍切到既有逐字稿的中間，請擴展到完整分段，避免刪除範圍外的文字。</p>
          <Button
            className="btn small"
            variant="outline"
            onClick={() => {
              setStart(String(range.start));
              setEnd(Number.isFinite(range.end) ? String(range.end) : '');
            }}
          >
            擴展到完整逐字稿範圍
          </Button>
        </div>
      )}
      {overlaps && (
        <>
          <p>
            與 {range.segments.length}{' '}
            段既有逐字稿重疊。以下原文將在全部分段成功後一次替換；取消或失敗時保留原文。
          </p>
          <div className="asr-replacement-preview">
            {range.segments.slice(0, 5).map((segment) => (
              <blockquote key={segment.id}>{segment.text}</blockquote>
            ))}
            {range.segments.length > 5 && <p>另有 {range.segments.length - 5} 段位於此範圍。</p>}
          </div>
          <label className="check-line">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            確認替換此範圍內的既有逐字稿
          </label>
        </>
      )}
      <p className="help">原始錄音與會議筆記會保留。刪除任務不會刪除錄音。</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <Button
        className="btn primary"
        disabled={busy || !valid || !aligned || (overlaps && !replace)}
        onClick={() => void submit()}
      >
        {busy ? '正在加入任務…' : '加入補辨識任務'}
      </Button>
    </div>
  );
}
