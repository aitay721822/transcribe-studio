const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

async function overview(page) {
  await page.locator('.setup-page, .hero').first().waitFor();
  if (await page.locator('.setup-page').count()) {
    // Non-onboarding suites use persisted local fixtures; there is no production bypass.
    await page.evaluate(async () => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.asr.fileUrl = 'http://127.0.0.1:1/v1/audio/transcriptions';
      s.asr.fileModel = s.asr.fileModel || 'local-file-model';
      s.asr.fileApiKey = s.asr.fileApiKey || 'local-file-fixture';
      if (s.asr.provider === 'openai' && (!s.asr.apiKey || !s.asr.model))
        s.asr.provider = 'transcriptions';
      if (!s.llm.apiKey || !s.llm.model) {
        s.llm.backend = 'openai';
        s.llm.apiKey = 'local-ui-fixture';
        s.llm.model = 'local-ui-model';
        s.llm.baseUrl = 'http://127.0.0.1:1/v1';
      }
      await window.studio.invoke('settings:save', s);
    });
    await page.reload();
  }
  await page.getByRole('heading', { name: '每段討論，都有脈絡。' }).waitFor();
}

async function desktopWindow(app) {
  const page = await firstWindow(app);
  await resizeWindow(app, page, 1280, 900);
  return page;
}

async function resizeWindow(app, page, width, height) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win.isMinimized()) win.restore();
        if (win.isMaximized()) win.unmaximize();
        win.setSize(size.width, size.height);
      },
      { width, height }
    );
    try {
      await page.waitForFunction((value) => innerWidth === value, width, { timeout: 5000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function firstWindow(app) {
  try {
    return await app.firstWindow({ timeout: 3000 });
  } catch (error) {
    // Packaged Electron may open before the automation client's window subscription.
    // Reattach to the same running browser, retaining real renderer and UI assertions.
    const directory = await app.evaluate(({ app }) => app.getPath('userData'));
    const [port, endpoint] = (await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split(/\r?\n/);
    if (!/^\d+$/.test(port) || !endpoint?.startsWith('/devtools/browser/')) throw error;
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`);
    app.once('close', () => {
      void browser.close().catch(() => {});
    });
    const context = browser.contexts()[0];
    if (!context) throw error;
    return context.pages()[0] || (await context.waitForEvent('page'));
  }
}

module.exports = { overview, desktopWindow, resizeWindow, firstWindow };
