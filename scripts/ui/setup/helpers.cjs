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
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await page.waitForFunction(() => innerWidth === 1280);
  return page;
}

module.exports = { overview, desktopWindow };
