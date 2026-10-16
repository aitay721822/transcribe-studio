import type { UiState } from '../../domain/models';
import { btn } from '../components/display';
import { icon } from '../components/icons';
import { Button } from '../primitives/button';
import { imageUrl } from './session/images';

export function agentActions(state: UiState) {
  return (
    <Button
      className={`composer-submit ${state.runId ? 'is-running' : ''}`}
      variant={state.runId ? 'secondary' : 'default'}
      size="icon"
      data-action={state.runId ? 'cancel-agent' : 'run-agent'}
      aria-label={state.runId ? '停止' : '送出'}
      title={state.runId ? '停止' : '送出'}
    >
      {state.runId ? (
        icon('stop')
      ) : (
        <svg
          className="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 19V5m-6 6 6-6 6 6" />
        </svg>
      )}
    </Button>
  );
}

export function queueView(state: UiState) {
  const queued = state.agentQueue || [];
  if (!queued.length) return '';
  return (
    <div className="agent-queue">
      <div className="agent-queue-heading">
        <span>
          {state.queuePaused ? '佇列已暫停' : '等待下一輪'} · {queued.length}
        </span>
        {state.queuePaused && !state.runId ? btn('繼續佇列', 'resume-agent', '', 'text small') : ''}
      </div>
      {queued.map((item, __index) => (
        <details className="agent-queue-item" key={item.id}>
          <summary>
            <span className="queue-glyph">{icon('list')}</span>
            {item.images?.length ? (
              <span className="queue-thumbnail">
                <img src={imageUrl(state.meetingId, item.images[0])} alt={item.images[0].name} />
                {item.images.length > 1 ? <span>{item.images.length}</span> : null}
              </span>
            ) : null}
            <span className="queue-message">
              {item.steering ? '引導傳送中 · ' : ''}
              {item.instruction}
            </span>
            <button
              type="button"
              className="queue-steer"
              data-steer-input={item.id}
              disabled={!state.runId || item.steering}
              onClick={(e) => e.preventDefault()}
              aria-label="引導目前工作"
              title="將這則排隊訊息改為引導目前工作"
            >
              ↳ <span>引導</span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              className="btn text small"
              data-cancel-input={item.id}
              aria-label="移除排隊訊息"
              disabled={item.steering}
              onClick={(e) => e.preventDefault()}
            >
              {icon('trash')}
            </Button>
          </summary>
          <div className="queue-detail">
            <p>{item.instruction}</p>
            {item.images?.length ? (
              <div className="chat-images">
                {item.images.map((image) => (
                  <img key={image.id} src={imageUrl(state.meetingId, image)} alt={image.name} />
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}
