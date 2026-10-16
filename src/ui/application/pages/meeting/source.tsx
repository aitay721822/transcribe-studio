import type { Meeting } from '../../../../domain/models';
import { DenoiseOption } from '../../../audio/processing/progress';
import { date, duration, empty } from '../../../components/display';
import { icon } from '../../../components/icons';
import { Button } from '../../../primitives/button';
import type { PageContext } from '../contracts';

export function sourceViews(context: PageContext) {
  const { state, current } = context;

  function transcriptView() {
    const m = current();
    if (!m?.segments.length)
      return empty('等待第一段聲音', '開始錄音後，辨識到的文字會出現在這裡。');
    return m.segments.map((s, __index) => (
      <article className={`segment ${s.final ? '' : 'partial'}`} key={s.id}>
        <div className="segment-meta">
          <button
            className="segment-time"
            data-seek={s.start}
            data-recording={s.recordingId || ''}
            title="定位音訊"
          >
            {duration(s.start)}
          </button>
          <span>{s.speaker || '未標示講者'}</span>
          <span title={s.timing === 'provider' ? '服務提供的時間戳' : '此時間為接收時間或概略時間'}>
            {s.timing === 'provider' ? '' : '≈'}
          </span>
        </div>
        <p>{s.text}</p>
      </article>
    ));
  }

  function sourceBody(m: Meeting) {
    if (state.sourceTab !== 'audio') return transcriptView();
    const audio = m.recordings.length
      ? m.recordings.map((r, __index) => (
          <div className="segment" key={r.id}>
            <div className="segment-meta">
              {date(r.startedAt)}
              {!r.complete ? ' · 未完成／中斷' : ''}
            </div>
            {r.complete ? (
              <>
                <audio
                  className="audio-player"
                  data-audio-id={r.id}
                  controls
                  preload="metadata"
                  src={r.url}
                />
                <DenoiseOption state={state} />
                <Button
                  variant="outline"
                  size="sm"
                  className="btn small"
                  data-retranscribe={r.id}
                  disabled={m.status === 'transcribing'}
                >
                  {icon('wave')}會後補辨識
                </Button>
              </>
            ) : (
              <p className="help">錄音尚未完成；音訊持續保留在本機，完成後可播放。</p>
            )}
          </div>
        ))
      : empty('尚無錄音', '會議音訊會保存在這台電腦。');
    const marks = m.markers.length ? (
      <>
        <h3>重點標記</h3>
        {m.markers.map((mark, __index) => (
          <p className="help" key={__index}>
            {duration(mark.time)} · {mark.label}
          </p>
        ))}
      </>
    ) : (
      ''
    );
    return (
      <>
        {audio}
        {marks}
      </>
    );
  }

  return {
    transcriptView,
    sourceBody,
  };
}
