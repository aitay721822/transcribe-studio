import { type ReactNode, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MotionProvider } from '../components/motion/provider';

const roots = new WeakMap<Element, Root>();
const dialogs = new WeakSet<Element>();

export function renderNodeInto(element: Element, node: ReactNode) {
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  if (element instanceof HTMLDialogElement && !dialogs.has(element)) {
    dialogs.add(element);
    element.addEventListener('close', () => {
      if (!element.open) unmountNode(element);
    });
  }
  flushSync(() => root.render(<MotionProvider>{node}</MotionProvider>));
}

export function unmountNode(element: Element) {
  roots.get(element)?.unmount();
  roots.delete(element);
}

const listeners = new Set<() => void>();
let revision = 0;

export function invalidateUI() {
  revision++;
  listeners.forEach((listener) => listener());
}

export function useUiRevision() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revision
  );
}
