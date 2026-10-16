import { app, type BrowserWindow, Menu } from 'electron';

export function installPlatformMenu(win: BrowserWindow) {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          {
            label: `結束 ${app.name}`,
            accelerator: 'Command+Q',

            click: () => win.close(),
          },
        ],
      },
      { role: 'editMenu' },
      { label: '視窗', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
    ])
  );
  app.on('activate', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}
