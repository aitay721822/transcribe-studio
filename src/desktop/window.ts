import path from 'node:path';
import { BrowserWindow, clipboard, desktopCapturer, dialog, session } from 'electron';
import type { DesktopContext } from './context';
import { mediaAccess } from './platform/media';
import { installPlatformMenu } from './platform/menu';

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
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
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
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (request.frame !== win.webContents.mainFrame) {
          callback(null);
          return;
        }
        await mediaAccess.prepare('system');
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (!sources.length) {
          callback(null);
          return;
        }
        let selected = 0;
        if (process.platform === 'darwin' && sources.length > 1) {
          const choice = await dialog.showMessageBox(win, {
            title: '選擇系統音訊擷取來源',
            message: '選擇要分享的螢幕',
            buttons: ['取消', ...sources.map((source) => source.name)],
            cancelId: 0,
            defaultId: 0,
          });
          if (!choice.response) {
            callback(null);
            return;
          }
          selected = choice.response - 1;
        }
        callback({ video: sources[selected], audio: 'loopback' });
      } catch {
        callback(null);
      }
    },
    { useSystemPicker: process.platform === 'darwin' }
  );
  installPlatformMenu(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  return win;
}

export function registerWindow(ctx: DesktopContext) {
  const { handle, win, recordings } = ctx;
  handle('media:status', mediaAccess.status);
  handle('media:prepare', mediaAccess.prepare);
  handle('media:settings', mediaAccess.openSettings);
  handle('clipboard:write', async (text) => {
    if (typeof text !== 'string' || text.length > 1000000) throw new Error('複製內容無效或過長');
    await clipboard.writeText(text);
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
