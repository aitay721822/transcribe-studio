const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-onboarding-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    await require('./helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.setup-page').waitFor();
    assert.equal(await page.locator('.sidebar, .topbar, .chrome-menu, #setup-skip').count(), 0);
    const screen = await page.locator('.setup-screen').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.equal(screen.width, viewport.width);
    assert.equal(screen.height, viewport.height);
    for (const key of ['Control+k', 'Control+n', 'Control+p', 'Control+s', 'Escape'])
      await page.keyboard.press(key);
    assert.equal(await page.locator('#search-palette, #modal[open], .hero').count(), 0);
    await page.reload();
    await page.locator('.setup-screen').waitFor();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/setup-asr-light.png' });
    await page.locator('#setup-next').click();
    await page.getByText('請先完成必填的離線辨識設定：HTTP 端點、模型及服務所需的驗證').waitFor();
    await page.locator('#setup-asr-file-url').fill('http://127.0.0.1:9001/v1/audio/transcriptions');
    await page.locator('#setup-asr-file-headers').fill('{"X-Example":"local"}');
    await page.locator('#setup-next').click();
    await page.getByRole('heading', { name: '選擇協助整理的 Agent' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '選擇協助整理的 Agent' }).waitFor();
    assert.equal(await page.locator('.sidebar, .hero').count(), 0);
    await page.locator('#setup-next').click();
    await page.getByText('請填妥服務網址、API key 與模型等必要欄位').waitFor();
    await page.waitForFunction(() => document.querySelector('#setup-detect')?.disabled === false);
    assert.equal(await page.locator('.detected-agent').count(), 2);
    const result = await page.evaluate(() => window.studio.invoke('agents:detect'));
    assert(
      result.every((a) => typeof a.installed === 'boolean' && typeof a.configured === 'boolean')
    );
    const installed = result.find((a) => a.runnable);
    if (installed) {
      await page.locator(`[data-setup-agent="${installed.id}"]`).click();
      assert.equal(await page.locator('#setup-backend').inputValue(), installed.id);
      assert.equal(await page.locator('#setup-cli-path').inputValue(), installed.path);
    }
    await page.locator('#setup-backend').selectOption('openai');
    await page.locator('#setup-backend').selectOption('codex');
    await page.locator('#setup-codex-auth').selectOption('api');
    await page.locator('#setup-llm-key').fill('local-probe-key');
    await page.locator('#setup-llm-model').fill('local-probe-model');
    await page.locator('#setup-cli-path').fill(path.join(profile, 'missing-agent.exe'));
    await page.locator('#setup-next').click();
    await page.getByText('找不到可啟動的 Codex，請確認 CLI 路徑或選擇其他 Agent').waitFor();
    assert.equal(await page.locator('.sidebar, .hero').count(), 0);
    await page.reload();
    await page.locator('.setup-screen').waitFor();
    await page.locator('#setup-backend').selectOption('openai');
    await page.locator('#setup-llm-key').fill('local-onboarding-key');
    await page.locator('#setup-llm-model').fill('local-selected-model');
    await page.locator('#setup-next').click();
    await page.getByRole('heading', { name: '工作區已準備好' }).waitFor();
    await page.screenshot({ path: 'output/playwright/setup-complete-light.png' });
    await page.locator('#setup-next').click();
    await page.locator('.hero').waitFor();
    await page.reload();
    await page.locator('.hero').waitFor();
    assert.equal(await page.locator('.setup-page').count(), 0);
    const settings = await page.evaluate(
      async () => (await window.studio.invoke('bootstrap')).settings
    );
    assert.equal(settings.llm.apiKey, '••••••••');
    assert.equal(settings.llm.model, 'local-selected-model');
    assert.equal(settings.asr.fileUrl, 'http://127.0.0.1:9001/v1/audio/transcriptions');
    const { DatabaseSync } = require('node:sqlite');

    const db = new DatabaseSync(path.join(profile, 'studio.sqlite'));
    const stored = db.prepare('SELECT data FROM settings').get().data;
    db.close();
    assert(!stored.includes('local-onboarding-key'));
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-action="setup"]').click();
    await page.locator('.setup-page').waitFor();
    await page.evaluate(async () => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.theme = 'dark';
      await window.studio.invoke('settings:save', s);
    });
    await page.reload();
    await page.locator('.hero').waitFor();
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-action="setup"]').click();
    await page.locator('.setup-page').waitFor();
    await page.waitForFunction(() => document.querySelector('#setup-detect')?.disabled === false);
    await page.screenshot({ path: 'output/playwright/setup-agent-dark.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 760));
    await page.waitForFunction(() => innerWidth <= 700);
    assert(await page.locator('#setup-next').isVisible());
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector('.setup-page').scrollWidth >
          document.querySelector('.setup-page').clientWidth
      ),
      false
    );
    await page.locator('#setup-next').click();
    await page.getByRole('heading', { name: '工作區已準備好' }).waitFor();
    await page.locator('#setup-next').click();
    await page.locator('.hero').waitFor();
    if (await page.evaluate(() => innerWidth < 900))
      await page.locator('[data-action="collapse-sidebar"]').click();
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    await page.locator('#llm-key').fill('');
    await page.locator('[data-action="save-settings"]').click();
    await page.locator('.setup-screen').waitFor();
    await page.reload();
    await page.locator('.setup-screen').waitFor();
    assert.equal(await page.locator('.sidebar, .hero').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Mandatory full-window setup passed: no skip/navigation bypass, shortcuts, partial save/reload, required services, detection, encrypted persistence, reopen, revoked configuration, themes and RWD.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
