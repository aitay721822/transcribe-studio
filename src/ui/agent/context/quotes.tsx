import type { Meeting, UiState } from '../../../domain/models';
import { invalidateUI } from '../../layout/roots';
import { Button } from '../../primitives/button';

export function ReplyQuotes({ state, meeting }: { state: UiState; meeting: Meeting }) {
  const drafts = state.annotationDrafts?.[meeting.id] || [];
  return drafts.length ? (
    <div className="reply-quotes" aria-label="待送出的引用">
      {drafts.map((draft) => (
        <article className={`reply-quote ${draft.status}`} key={draft.id} data-reply-id={draft.id}>
          <Button
            variant="ghost"
            size="bare"
            type="button"
            className="reply-remove"
            aria-label="移除引用"
            onClick={() => {
              state.annotationDrafts[meeting.id] = drafts.filter((a) => a.id !== draft.id);
              invalidateUI();
            }}
          >
            ×
          </Button>
          <blockquote>{draft.quote}</blockquote>
          <span>{draft.status === 'stale' ? '原文已變動，請重新選取' : '回覆'}</span>
          {draft.comment && <p className="reply-comment">{draft.comment}</p>}
        </article>
      ))}
    </div>
  ) : null;
}
