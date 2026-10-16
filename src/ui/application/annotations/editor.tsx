import { useEffect, useRef } from 'react';
import type { Meeting, UiState } from '../../../domain/models';
import { btn, empty } from '../../components/display';
import { invalidateUI } from '../../layout/roots';
import { Textarea } from '../../primitives/textarea';
import { shortcutLabel } from '../platform/shortcuts';
import { markdown, markedText } from './markdown';
import { previewSelection } from './selection';
import { SelectionToolbar } from './selection/toolbar';

export function NotesPane({ meeting: m, state }: { meeting: Meeting; state: UiState }) {
  const preview = useRef<HTMLDivElement>(null),
    backdrop = useRef<HTMLDivElement>(null);
  const saved = m.annotations || [],
    drafts = state.annotationDrafts?.[m.id] || [];
  const marks = [...saved.filter((a) => !drafts.some((d) => d.id === a.id)), ...drafts],
    pending = saved.filter((a) => a.status === 'pending');
  useEffect(() => {
    const selected = () => {
      const editor = document.activeElement;

      const selectedRange = () => {
        if (editor instanceof HTMLTextAreaElement && editor.id === 'notes-editor') {
          if (editor.selectionEnd > editor.selectionStart) {
            return {
              start: editor.selectionStart,
              end: editor.selectionEnd,
              quote: editor.value.slice(editor.selectionStart, editor.selectionEnd),
            };
          }
          return undefined;
        }
        if (preview.current) {
          return previewSelection(preview.current, m.notes);
        }
        return undefined;
      };

      const value = selectedRange();
      if (
        !value &&
        ((editor instanceof HTMLTextAreaElement && editor.id === 'notes-editor') ||
          (window.getSelection()?.isCollapsed &&
            preview.current?.contains(window.getSelection()?.anchorNode))) &&
        state.noteSelection
      ) {
        state.noteSelection = undefined;
        state.selectionLength = 0;
        invalidateUI();
        return;
      }
      if (
        !value ||
        (value.start === state.noteSelection?.start && value.end === state.noteSelection?.end)
      )
        return;
      state.noteSelection = { meetingId: m.id, ...value };
      state.selectionLength = value.end - value.start;
      invalidateUI();
    };

    document.addEventListener('selectionchange', selected);
    document.addEventListener('select', selected, true);
    return () => {
      document.removeEventListener('selectionchange', selected);
      document.removeEventListener('select', selected, true);
    };
  }, [m.notes, m.id, state]);
  return (
    <section className="workspace-pane notes-pane" aria-label="會議紀錄">
      <SelectionToolbar meetingId={m.id} tab={state.editorTab} />
      <div className="tabs">
        <button
          className={`tab ${state.editorTab === 'edit' ? 'active' : ''}`}
          data-editor-tab="edit"
        >
          編輯
        </button>
        <button
          className={`tab ${state.editorTab === 'preview' ? 'active' : ''}`}
          data-editor-tab="preview"
        >
          預覽
        </button>
        <div className="notes-save">{btn('儲存', 'save-notes', 'check', 'small text')}</div>
      </div>
      <div className="editor-meta">
        <span>Markdown 文件</span>
        <span id="save-status">{state.dirty ? '尚未儲存' : `已儲存 · 版本 ${m.version}`}</span>
      </div>
      {state.editorTab === 'edit' ? (
        <div className="marked-editor">
          <div className="notes-backdrop" ref={backdrop} aria-hidden="true">
            {markedText(m.notes, 0, marks)}
            {'\n'}
          </div>
          <Textarea
            className="notes-editor"
            id="notes-editor"
            aria-label="會議紀錄編輯器"
            placeholder={
              '在這裡寫下會議重點…\n\n或交給右側 Agent，參考逐字稿與專案資料，整理成摘要、決議與待辦事項。'
            }
            value={m.notes}
            onChange={() => {}}
            onScroll={(e) => {
              if (backdrop.current) {
                backdrop.current.scrollTop = e.currentTarget.scrollTop;
                backdrop.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
          />
        </div>
      ) : (
        <div className="document-preview" ref={preview} id="notes-preview">
          {m.notes
            ? markdown(m.notes, marks, m)
            : empty('紀錄尚未撰寫', '在編輯頁手動撰寫，或交給 Agent 整理。')}
        </div>
      )}
      {saved.length > 0 && (
        <section className="note-annotations" aria-label="Markdown 標記">
          <div className="annotation-heading">
            <span>標記 · {pending.length} 則待修訂</span>
            <button data-action="revise-annotations" disabled={!pending.length}>
              加入訊息框
            </button>
          </div>
          {saved.map((a, i) => {
            const annotationStatus = () => {
              if (a.status === 'stale') {
                return '原文已變動，請重新選取';
              }
              if (a.status === 'resolved') {
                return '已套用';
              }
              return '待修訂';
            };

            return (
              <article
                className={`note-annotation ${a.status}`}
                key={a.id}
                data-annotation-id={a.id}
              >
                <div className="annotation-heading">
                  <button
                    className="annotation-locate"
                    disabled={a.status !== 'pending'}
                    onClick={() => {
                      if (state.editorTab === 'edit') {
                        const editor = document.querySelector<HTMLTextAreaElement>('#notes-editor');
                        editor?.focus();
                        editor?.setSelectionRange(a.start, a.end);
                      } else
                        preview.current
                          ?.querySelector(`[data-note-mark="${a.id}"]`)
                          ?.scrollIntoView({ block: 'center' });
                    }}
                  >
                    #{i + 1} · {annotationStatus()}
                  </button>
                  <div className="button-row">
                    <button data-annotation-edit={a.id}>
                      {a.status !== 'pending' ? '重新標記' : '編輯'}
                    </button>
                    <button data-annotation-remove={a.id} aria-label={`移除標記 ${i + 1}`}>
                      移除
                    </button>
                  </div>
                </div>
                <blockquote>{a.quote}</blockquote>
                <p>{a.comment}</p>
              </article>
            );
          })}
        </section>
      )}
      <div className="editor-footer">
        <span id="word-count">{m.notes.length} 字</span>
        <span>{shortcutLabel('S')} 儲存 · 選取文字後加入修改標記</span>
      </div>
    </section>
  );
}
