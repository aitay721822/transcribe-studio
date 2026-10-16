interface ShortcutEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export function currentPlatform() {
  return document.documentElement.dataset.platform || 'win32';
}

export function shortcutLabel(letter: string, action = false, platform = currentPlatform()) {
  if (platform === 'darwin') return `⌘${action ? '⇧' : ''}${letter.toUpperCase()}`;
  return `Ctrl+${action ? 'Alt+' : ''}${letter.toUpperCase()}`;
}

export function actionShortcut(event: ShortcutEvent, letter: string, platform = currentPlatform()) {
  if (event.isComposing) return false;
  const key = event.code || `Key${event.key.toUpperCase()}`;
  if (key !== `Key${letter.toUpperCase()}`) return false;
  if (platform === 'darwin')
    return event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey;
  return event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey;
}
