import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { selectedRect, visibleRect } from './geometry';

export function SelectionToolbar({ meetingId, tab }: { meetingId: string; tab: string }) {
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let frame = 0,
      selecting = false;

    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const editor = document.querySelector<HTMLTextAreaElement>('#notes-editor');
        const preview = document.querySelector<HTMLElement>('#notes-preview');
        let rect: DOMRect;
        if (
          !selecting &&
          editor === document.activeElement &&
          editor.selectionEnd > editor.selectionStart &&
          editor.value.slice(editor.selectionStart, editor.selectionEnd).trim()
        )
          rect = selectedRect(editor, document.querySelector('.notes-backdrop'));
        else if (!selecting && preview && !document.querySelector('#modal[open]')) {
          const selection = getSelection();
          if (
            selection?.rangeCount &&
            !selection.isCollapsed &&
            preview.contains(selection.anchorNode) &&
            preview.contains(selection.focusNode) &&
            selection.toString().trim() &&
            !(document.activeElement instanceof HTMLTextAreaElement)
          )
            rect = visibleRect(selection.getRangeAt(0), preview);
        }
        setPosition(rect ? { x: rect.left + rect.width / 2, y: rect.top } : undefined);
      });
    };

    const down = (event: PointerEvent) => {
      if (button.current?.contains(event.target as Node)) return;
      selecting = !!(event.target as Element).closest('#notes-editor, #notes-preview');
      setPosition(undefined);
    };

    const up = () => {
      selecting = false;
      update();
    };

    const focus = (event: FocusEvent) => {
      if (!(event.target as Element).closest('#notes-editor, #notes-preview, .selection-toolbar'))
        setPosition(undefined);
    };

    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPosition(undefined);
    };

    document.addEventListener('selectionchange', update);
    document.addEventListener('select', update, true);
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('focusin', focus);
    document.addEventListener('keydown', escape);
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const observer = new ResizeObserver(update);
    const pane = document.querySelector('.notes-pane');
    if (pane) observer.observe(pane);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('select', update, true);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [meetingId, tab]);
  return position
    ? createPortal(
        <button
          ref={button}
          className="selection-toolbar"
          data-action="add-annotation"
          style={{
            left: Math.max(12, Math.min(innerWidth - 296, position.x - 142)),
            top: Math.max(8, position.y - 48),
          }}
          onMouseDown={(e) => e.preventDefault()}
          aria-keyshortcuts="Control+Alt+M"
        >
          標記選取文字 <kbd>Ctrl Alt M</kbd>
        </button>,
        document.body
      )
    : null;
}
