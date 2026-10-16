const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-material-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.locator('.sidebar').waitFor();
    if (process.env.STUDIO_PREVIEW_WORKSPACE) {
      const meetingId = await page.evaluate(async () => {
        const p = await window.studio.invoke('project:create', '產品研發');
        await window.studio.invoke('project:create', '客戶訪談');
        await window.studio.invoke('project:create', '營運例會');
        const m = await window.studio.invoke('meeting:create', p.id, '產品週會 · 上線規劃', 'file');
        await window.studio.invoke(
          'meeting:update',
          m.id,
          {
            status: 'completed',
            notes:
              '# 產品週會\n\n## 會議摘要\n確認第一版會議工作台的功能範圍，以及下一階段的整合驗證。\n\n## 決議\n- 採用多資料夾專案工作區。\n- 保留逐字稿與會議紀錄的版本歷史。\n- 修訂內容先經確認，再套用至文件。\n\n## 待辦事項\n| 事項 | 負責人 | 期限 |\n| --- | --- | --- |\n| 驗證 ASR 服務接入 | 待確認 | 待確認 |\n| 檢查 Word 匯出格式 | 待確認 | 待確認 |',
          },
          0
        );
        return m.id;
      });
      await page.reload();
      await page.locator(`[data-meeting="${meetingId}"]`).first().click();
      await page.locator('[data-editor-tab="preview"]').click();
    }
    await app.evaluate(async ({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows()[0];
      const display = screen.getPrimaryDisplay();
      main.setMinimumSize(900, 540);
      main.setBounds({
        x: display.workArea.x + 5,
        y: display.workArea.y + 5,
        width: Math.min(1160, display.workArea.width - 10),
        height: Math.min(730, display.workArea.height - 10),
      });
      const r = main.getBounds();
      const backdrop = new BrowserWindow({
        x: r.x - 20,
        y: r.y - 20,
        width: r.width + 40,
        height: r.height + 40,
        frame: false,
        skipTaskbar: true,
        show: false,
        webPreferences: { sandbox: true },
      });
      const html =
        '<!doctype html><body style="margin:0;background:repeating-linear-gradient(90deg,#ffffff 0 4px,#151515 4px 8px);height:100vh"><div style="position:absolute;inset:0;background:linear-gradient(110deg,#e6a09766 0 30%,#a9c9b966 30% 60%,#b4bee966 60%);display:flex;align-items:center;font:bold 90px sans-serif;color:#0008">BACKGROUND TEXT 123</div></body>';
      await backdrop.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      backdrop.showInactive();
      main.setAlwaysOnTop(true);
      main.show();
      main.focus();
      globalThis.materialPreview = { main, backdrop };
    });
    await fs.mkdir('output/playwright', { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (theme) => {
        const s = (await window.studio.invoke('bootstrap')).settings;
        s.theme = theme;
        await window.studio.invoke('settings:save', s);
        document.documentElement.dataset.theme = theme;
      }, theme);
      await new Promise((r) => setTimeout(r, 1000));
      const png = await app.evaluate(async ({ desktopCapturer, screen }) => {
        const { main } = globalThis.materialPreview;
        const bounds = main.getBounds();
        const display = screen.getDisplayMatching(bounds);
        const scale = display.scaleFactor;
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: Math.round(display.size.width * scale),
            height: Math.round(display.size.height * scale),
          },
        });
        const src = sources.find((s) => s.display_id === String(display.id));
        if (!src) throw new Error('沒有取得測試視窗所在螢幕');
        const image = src.thumbnail.crop({
          x: Math.round((bounds.x - display.bounds.x) * scale),
          y: Math.round((bounds.y - display.bounds.y) * scale),
          width: Math.round(bounds.width * scale),
          height: Math.round(bounds.height * scale),
        });
        return image.toPNG().toString('base64');
      });
      await fs.writeFile(`output/playwright/material-${theme}.png`, Buffer.from(png, 'base64'));
    }
    console.log('Native compositor previews saved against a synthetic striped background.');
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
