import { useState } from 'react';
import type { NoteAnnotation } from '../../../domain/annotations';
import { rebaseAnnotations } from '../../../domain/annotations';
import { invalidateUI } from '../../layout/roots';
import { Button } from '../../primitives/button';
import { Textarea } from '../../primitives/textarea';
import type { UiRuntime } from '../runtime';
import type { WorkspaceController } from '../workspace';
import { previewSelection } from './selection';

function AnnotationForm({
  quote,
  comment,
  save,
  close,
  staging = false,
}: {
  quote: string;
  comment: string;
  save(comment: string): Promise<void>;
  close(): void;
  staging?: boolean;
}) {
  const [value, setValue] = useState(comment),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');

  const saveLabel = () => {
    if (staging) {
      if (busy) {
        return '加入中…';
      }
      return '加入訊息框';
    }
    if (busy) {
      return '儲存中…';
    }
    return '儲存標記';
  };

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          await save(value);
          close();
        } catch (caughtE) {
          const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {!staging && <p className="help">Agent 只會替換這段原文，保留其他 Markdown。</p>}
      <blockquote className="annotation-quote">{quote}</blockquote>
      <label htmlFor="annotation-comment">{staging ? '回覆' : '修改指示'}</label>
      <Textarea
        id="annotation-comment"
        data-initial-focus
        aria-label={staging ? '回覆內容' : '標記修改指示'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          staging ? '針對這段文字填寫回覆或修改要求…' : '例如：補上負責人與期限，不明處標示待確認。'
        }
        required
        maxLength={4000}
      />
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="annotation-form-actions">
        <Button type="button" variant="outline" onClick={close}>
          取消
        </Button>
        <Button
          type="submit"
          id={staging ? 'add-reply' : 'save-annotation'}
          disabled={busy || !value.trim()}
        >
          {saveLabel()}
        </Button>
      </div>
    </form>
  );
}

export function createAnnotationController(host: UiRuntime, workspace: WorkspaceController) {
  const { state, current, api, updateMeeting, showModal, render, toast } = host;

  function attach(marks: NoteAnnotation[]) {
    const meeting = current();
    state.annotationDrafts ||= {};
    const drafts = [...(state.annotationDrafts[meeting.id] || [])];
    for (const mark of marks) {
      const duplicate = drafts.findIndex(
        (a) =>
          a.start === mark.start &&
          a.end === mark.end &&
          a.quote === mark.quote &&
          a.status === 'pending'
      );
      if (duplicate >= 0) {
        drafts[duplicate] = { ...drafts[duplicate], comment: mark.comment };
        continue;
      }
      if (drafts.some((a) => a.status === 'pending' && a.start < mark.end && mark.start < a.end))
        throw new Error('引用範圍重疊，請移除原引用後再加入');
      if (drafts.length >= 50) throw new Error('最多可加入 50 段引用');
      drafts.push({ ...mark });
    }
    state.annotationDrafts[meeting.id] = drafts;
    state.noteSelection = undefined;
    state.selectionLength = 0;
    invalidateUI();
    const input = document.querySelector<HTMLTextAreaElement>('#agent-input');
    input?.focus();
    requestAnimationFrame(() => {
      input?.focus();
      input?.scrollIntoView({ block: 'nearest' });
    });
  }

  async function stage() {
    const editor = document.querySelector<HTMLTextAreaElement>('#notes-editor');
    const preview = document.querySelector<HTMLElement>('#notes-preview');

    const selectedRange = () => {
      if (editor === document.activeElement) {
        return {
          start: editor.selectionStart,
          end: editor.selectionEnd,
          quote: editor.value.slice(editor.selectionStart, editor.selectionEnd),
        };
      }
      if (preview && !(document.activeElement instanceof HTMLTextAreaElement)) {
        return previewSelection(preview, current().notes);
      }
      return undefined;
    };

    const range = selectedRange();

    const selectedAnnotation = () => {
      if (range) {
        return { meetingId: current().id, ...range };
      }
      if (document.activeElement?.closest('.selection-toolbar')) {
        return state.noteSelection;
      }
      return undefined;
    };

    const selected = selectedAnnotation();
    await workspace.saveNotes();
    const meeting = current();
    if (
      !selected ||
      selected.meetingId !== meeting.id ||
      !selected.quote.trim() ||
      meeting.notes.slice(selected.start, selected.end) !== selected.quote
    )
      throw new Error('請先在編輯或預覽中選取要回覆的文字');
    if (selected.quote.length > 80000) throw new Error('單段引用最多 80,000 字，請縮小選取範圍');
    const existing = [
      ...(state.annotationDrafts?.[meeting.id] || []),
      ...(meeting.annotations || []),
    ].find(
      (a) =>
        a.status === 'pending' &&
        a.start === selected.start &&
        a.end === selected.end &&
        a.quote === selected.quote
    );
    const mark: NoteAnnotation = existing || {
      id: crypto.randomUUID(),
      start: selected.start,
      end: selected.end,
      quote: selected.quote,
      comment: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const sourceNotes = meeting.notes;
    const modal = showModal(
      '回覆選取文字',
      <AnnotationForm
        staging
        quote={mark.quote}
        comment={mark.comment}
        close={() => modal.close()}
        save={async (comment) => {
          await workspace.saveNotes();
          if (current().id !== meeting.id) throw new Error('目前會議已改變，請重新選取');
          const rebased = rebaseAnnotations([{ ...mark }], sourceNotes, current().notes)[0];
          if (
            rebased.status !== 'pending' ||
            current().notes.slice(rebased.start, rebased.end) !== rebased.quote
          )
            throw new Error('引用原文已變動，請取消後重新選取');
          attach([{ ...rebased, comment: comment.trim() }]);
        }}
      />
    );
  }

  async function stagePending() {
    await workspace.saveNotes();
    const marks = (current().annotations || []).filter((a) => a.status === 'pending');
    if (!marks.length) throw new Error('目前沒有待修訂標記');
    attach(marks);
  }

  async function edit(id?: string) {
    const selection = state.noteSelection;
    await workspace.saveNotes();
    const meeting = current();
    const old = id ? meeting.annotations?.find((a) => a.id === id) : undefined;
    if (id && !old) throw new Error('找不到標記');
    const range = !old || old.status !== 'pending' ? selection : old;
    if (
      !range ||
      ('meetingId' in range && range.meetingId !== meeting.id) ||
      meeting.notes.slice(range.start, range.end) !== range.quote ||
      !range.quote.trim()
    )
      throw new Error('請先在編輯或預覽中選取要修改的文字');
    const mark: NoteAnnotation = {
      id: old?.id || crypto.randomUUID(),
      start: range.start,
      end: range.end,
      quote: range.quote,
      comment: old?.comment || '',
      status: 'pending',
      createdAt: old?.createdAt || new Date().toISOString(),
    };
    const modal = showModal(
      old ? '編輯標記' : '標記 Markdown',
      <AnnotationForm
        quote={mark.quote}
        comment={mark.comment}
        close={() => modal.close()}
        save={async (comment) => {
          await workspace.saveNotes();
          if (state.meetingId !== meeting.id) throw new Error('目前會議已改變');
          const marks = current().annotations || [];
          if (
            marks.some(
              (a) =>
                a.id !== mark.id &&
                a.status === 'pending' &&
                a.start < mark.end &&
                mark.start < a.end
            )
          )
            throw new Error('範圍與其他標記重疊，請調整選取或移除重疊標記');
          const next = old
            ? marks.map((a) => (a.id === mark.id ? { ...mark, comment } : a))
            : [...marks, { ...mark, comment }];
          updateMeeting(
            await api('meeting:update', meeting.id, { annotations: next }, current().version)
          );
          if (state.annotationDrafts?.[meeting.id])
            state.annotationDrafts[meeting.id] = state.annotationDrafts[meeting.id].map((a) =>
              a.id === mark.id ? { ...mark, comment } : a
            );
          state.noteSelection = undefined;
          state.selectionLength = 0;
          render();
          toast('標記已儲存');
        }}
      />
    );
  }

  async function remove(id: string) {
    await workspace.saveNotes();
    const meeting = current();
    updateMeeting(
      await api(
        'meeting:update',
        meeting.id,
        { annotations: (meeting.annotations || []).filter((a) => a.id !== id) },
        meeting.version
      )
    );
    if (state.annotationDrafts?.[meeting.id])
      state.annotationDrafts[meeting.id] = state.annotationDrafts[meeting.id].filter(
        (a) => a.id !== id
      );
    render();
  }

  return { edit, remove, stage, stagePending };
}

export type AnnotationController = ReturnType<typeof createAnnotationController>;
