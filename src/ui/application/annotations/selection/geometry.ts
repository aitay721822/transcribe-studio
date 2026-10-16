/** The editor backdrop shares textarea typography, wrapping, padding and scroll position. */
export function selectedRect(editor: HTMLTextAreaElement, backdrop: HTMLElement) {
  const range = document.createRange();

  const point = (offset: number) => {
    const spans = [...backdrop.querySelectorAll<HTMLElement>('[data-source-start]')];
    const span = spans.find(
      (s) =>
        offset >= Number(s.dataset.sourceStart) &&
        offset <= Number(s.dataset.sourceStart) + s.textContent.length
    );
    if (!span) return;
    let remaining = offset - Number(span.dataset.sourceStart);
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.textContent.length) return { node, offset: remaining };
      remaining -= node.textContent.length;
    }
  };

  const start = point(editor.selectionStart),
    end = point(editor.selectionEnd);
  if (!start || !end) return;
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return visibleRect(range, editor);
}

export function visibleRect(range: Range, element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  let top = Math.max(0, bounds.top),
    bottom = Math.min(innerHeight, bounds.bottom);
  let left = Math.max(0, bounds.left),
    right = Math.min(innerWidth, bounds.right);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent),
      box = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
  }
  return [...range.getClientRects()].find(
    (r) => r.width > 0 && r.bottom > top && r.top < bottom && r.right > left && r.left < right
  );
}
