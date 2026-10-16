/** Source spans map rendered text (including bold/table cells) back to Markdown offsets. */
export function previewSelection(root: HTMLElement, notes: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined;

  const point = (node: Node, offset: number, endPoint = false): number | undefined => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const span = element?.closest<HTMLElement>('[data-source-start]');
    if (!span || !root.contains(span)) {
      let previous: number | undefined;
      for (const leaf of root.querySelectorAll<HTMLElement>('[data-source-start]')) {
        const bounds = document.createRange();
        bounds.selectNodeContents(leaf);
        if (bounds.comparePoint(node, offset) <= 0) return Number(leaf.dataset.sourceStart);
        previous =
          Number(leaf.dataset.sourceStart) +
          Number(leaf.dataset.sourceLength || leaf.textContent.length);
      }
      return previous;
    }
    if (span.dataset.sourceLength)
      return Number(span.dataset.sourceStart) + (endPoint ? Number(span.dataset.sourceLength) : 0);
    const prefix = document.createRange();
    prefix.selectNodeContents(span);
    prefix.setEnd(node, offset);
    return Number(span.dataset.sourceStart) + prefix.toString().length;
  };

  const start = point(range.startContainer, range.startOffset),
    end = point(range.endContainer, range.endOffset, true);
  return start !== undefined && end !== undefined && end > start
    ? { start, end, quote: notes.slice(start, end) }
    : undefined;
}
