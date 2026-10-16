import type { ReactNode } from 'react';
import { renderNodeInto, unmountNode } from './roots';

/** A React-owned transient surface; its platform host contains no generated markup. */
export function mountOverlay(
  content: (close: () => void) => ReactNode,
  parent: Element = document.body
) {
  const container = document.createElement('div');
  container.style.display = 'contents';
  parent.append(container);
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    unmountNode(container);
    container.remove();
  };

  renderNodeInto(container, content(close));
  return close;
}
