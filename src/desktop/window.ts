import path from 'node:path';
import { BrowserWindow, clipboard, desktopCapturer, session } from 'electron';
import type { DesktopContext } from './context';

export function createWindow(preload: string) {
  const win = new BrowserWindow({
    width: 1530,
    height: 960,
    minWidth: 480,
    minHeight: 540,
    show: false,
    title: 'Transcribe Studio',
    icon: path.join(path.dirname(preload), '..', 'ui', 'branding', 'icon.png'),
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(contents === win.webContents && ['media', 'display-capture'].includes(permission))
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) =>
      contents === win.webContents && ['media', 'display-capture'].includes(permission)
  );
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      callback(null);
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  return win;
}

export function registerWindow(ctx: DesktopContext) {
  const { handle, win, recordings } = ctx;
  handle('clipboard:write', (text) => {
    if (typeof text !== 'string' || text.length > 1000000) throw new Error('複製內容無效或過長');
    clipboard.writeText(text);
  });
  handle('window:control', (action) => {
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') win.close();
    if (action === 'close-confirmed' && !recordings.size) {
      ctx.setClosing();
      win.close();
    }
  });
}
