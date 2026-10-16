const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-responsive-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: [
      ...(process.env.STUDIO_PACKAGED ? [] : ['.']),
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    env,
  });
  try {
    await require('./setup/helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await require('./setup/helpers.cjs').overview(page);
    const separator = page.getByRole('separator', { name: '調整專案側欄寬度' });
    const before = (await page.locator('.sidebar').boundingBox()).width;
    const box = await separator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 80, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(
      (width) => document.querySelector('.sidebar').getBoundingClientRect().width > width + 40,
      before
    );
    const width = (await page.locator('.sidebar').boundingBox()).width;
    assert(width <= 361);
    await page.reload();
    await page.locator('.sidebar').waitFor();
    await page.waitForFunction(
      (width) =>
        Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - width) < 3,
      width
    );
    assert(Math.abs((await page.locator('.sidebar').boundingBox()).width - width) < 3);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 760));
    await page.waitForFunction(() =>
      document.querySelector('.shell').classList.contains('compact-shell')
    );
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    await page.getByRole('button', { name: '展開專案側欄', exact: true }).click();
    await page.getByRole('dialog', { name: '專案導覽' }).waitFor();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '展開專案側欄', exact: true }).waitFor();
    await page.getByRole('button', { name: '展開專案側欄', exact: true }).click();
    await page.locator('[data-action="new-project"]').click();
    await page.locator('#name-input').fill('專案管理測試');
    await page.locator('#name-confirm').click();
    await page.getByRole('heading', { name: '專案管理測試', exact: true }).waitFor();
    await page.locator('[data-action="rename-project"]').click();
    await page.locator('#name-input').fill('已編輯專案');
    await page.locator('#name-confirm').click();
    await page.getByRole('heading', { name: '已編輯專案', exact: true }).waitFor();
    await page.locator('[data-action="archive-project"]').click();
    await page.getByRole('button', { name: '解除封存', exact: true }).waitFor();
    await page.locator('[data-action="archive-project"]').click();
    await page.getByRole('button', { name: '封存專案', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await page.waitForFunction(
      () => !document.querySelector('.shell').classList.contains('compact-shell')
    );
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    await page.locator('[data-action="refresh-devices"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('#audio-device optgroup[label="麥克風"] option').length > 1
    );
    const device = await page
      .locator('#audio-device optgroup[label="麥克風"] option')
      .nth(1)
      .getAttribute('value');
    const deviceLabel = await page
      .locator('#audio-device optgroup[label="麥克風"] option')
      .nth(1)
      .textContent();
    const dropdown = page.getByRole('combobox', { name: /^裝置音量/ });
    await dropdown.click();
    const search = page.getByRole('searchbox', { name: '搜尋裝置音量' });
    await search.fill(deviceLabel);
    assert(await page.getByRole('option', { name: deviceLabel, exact: true }).isVisible());
    await page.getByRole('option', { name: deviceLabel, exact: true }).click();
    assert.equal(await page.locator('#audio-device').inputValue(), device);
    assert.equal(await dropdown.evaluate((element) => document.activeElement === element), true);
    const fixture = await require('esbuild').build({
      entryPoints: ['scripts/ui/design/select-fixture.tsx'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
    });
    await page.evaluate(fixture.outputFiles[0].text);
    const projectDropdown = page.getByRole('combobox', { name: /^測試專案/ });
    await projectDropdown.click();
    const projectSearch = page.getByRole('searchbox', { name: '搜尋測試專案' });
    assert.equal(
      await page
        .locator('.dropdown-options')
        .evaluate((element) => element.scrollHeight > element.clientHeight),
      true
    );
    await projectSearch.fill('不可選取');
    assert.equal(await page.getByRole('option').isDisabled(), true);
    await projectSearch.press('Enter');
    assert.equal(await page.locator('.dropdown-popup').isVisible(), true);
    await projectSearch.fill('');
    await projectSearch.press('End');
    assert.equal(await page.locator('.dropdown-option.is-active').textContent(), '長清單測試 24');
    await projectSearch.press('Escape');
    await projectDropdown.click();
    await page.getByRole('heading', { name: '音訊來源', exact: true }).click();
    assert.equal(await page.locator('.dropdown-popup').count(), 0);
    await page.evaluate(() => window.cleanupSelectFixture());
    await dropdown.press('ArrowDown');
    assert.equal(
      await page
        .getByRole('option', { name: deviceLabel, exact: true })
        .getAttribute('aria-selected'),
      'true'
    );
    assert.equal(
      await page
        .getByRole('option', { name: deviceLabel, exact: true })
        .locator('.dropdown-check svg')
        .count(),
      1
    );
    await search.fill('沒有這個裝置');
    await page.getByText('沒有符合的選項', { exact: true }).waitFor();
    await search.fill('');
    await search.press('End');
    assert.equal(
      await page.locator('.dropdown-option.is-active').textContent(),
      '系統音訊＋選定麥克風'
    );
    await search.press('Escape');
    await dropdown.waitFor();
    assert.equal(await page.locator('.dropdown-popup').count(), 0);
    await dropdown.click();
    await search.fill(deviceLabel);
    await search.press('Enter');
    assert.equal(await page.locator('#audio-device').inputValue(), device);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 760));
    await dropdown.click();
    const popupBox = await page.locator('.dropdown-popup').boundingBox();
    assert(popupBox.x >= 0 && popupBox.x + popupBox.width <= 600);
    await search.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('[data-theme-option="dark"]').click();
    await page.locator('[data-action="save-settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    await page.getByRole('combobox', { name: /^Agent 類型/ }).click();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.evaluate(() =>
      document.querySelectorAll('#toasts button').forEach((button) => button.click())
    );
    await page.screenshot({ path: 'output/playwright/dropdown-dark.png' });
    await page
      .locator('.dropdown-popup')
      .screenshot({ path: 'output/playwright/dropdown-menu.png' });
    await page.getByRole('searchbox', { name: '搜尋Agent 類型' }).press('Escape');
    await page.locator('[data-action="back-workspace"]').click();
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    await page.evaluate(() => {
      window.testStreams = [];
      window.audioConstraints = [];
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        window.audioConstraints.push(constraints);
        const stream = await get(constraints);
        window.testStreams.push(stream);
        return stream;
      };
    });
    await page.locator('[data-action="test-audio"]').click();
    await page.getByText('來源已連接，播放聲音或說話以確認音量。', { exact: true }).waitFor();
    const observations = await page.evaluate(async () => {
      let updates = 0;
      const bars = document.querySelector('#test-level');
      const observer = new MutationObserver((records) => {
        updates += records.length;
      });
      observer.observe(bars, { attributes: true, subtree: true });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      observer.disconnect();
      return {
        updates,
        deviceId: window.audioConstraints.at(-1).audio.deviceId.exact,
        heights: [...bars.children].map((b) => b.style.height),
      };
    });
    assert.equal(observations.deviceId, device.slice(4));
    assert(observations.updates <= 880);
    assert(observations.heights.every((h) => h === ''));
    await page.locator('[data-close-modal]').click();
    await page.waitForFunction(() =>
      window.testStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))
    );
    await page.locator('[data-audio-mode="file"]').click();
    await page.getByRole('heading', { name: '音訊檔案', exact: true }).waitFor();
    assert.equal(await page.locator('#audio-device').count(), 0);
    await page.locator('[data-audio-mode="device"]').click();
    await page.waitForFunction(() => document.querySelector('#audio-device')?.disabled === false);
    assert.equal(await page.locator('#audio-device').inputValue(), device);
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/device-source.png' });
    await page.locator('#record-only').check();
    await page.getByRole('button', { name: '開始會議', exact: true }).click();
    await page.locator('#name-input').fill('指定裝置錄音');
    await page.locator('#name-confirm').click();
    await page.locator('[data-action="stop-recording"]').waitFor();
    assert.equal(
      await page.evaluate(() => window.audioConstraints.at(-1).audio.deviceId.exact),
      device.slice(4)
    );
    const busy = await page.evaluate(async () => {
      const project = (await window.studio.invoke('bootstrap')).projects[0];
      try {
        await window.studio.invoke('project:delete', project.id);
        return false;
      } catch (error) {
        return error.message.includes('請先結束');
      }
    });
    assert.equal(busy, true);
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    await page.locator('#notes-editor').fill('窄視窗保留未儲存筆記');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 760));
    await page.waitForFunction(() =>
      document.querySelector('.shell').classList.contains('compact-shell')
    );
    assert.equal(await page.locator('#notes-editor').inputValue(), '窄視窗保留未儲存筆記');
    await page.screenshot({ path: 'output/playwright/responsive-workspace.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await page.waitForFunction(
      () => !document.querySelector('.shell').classList.contains('compact-shell')
    );
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="delete-project"]').click();
    await page.locator('#cancel-delete-project').click();
    assert.equal(
      (await page.evaluate(async () => (await window.studio.invoke('bootstrap')).projects)).length,
      1
    );
    await page.locator('[data-action="delete-project"]').click();
    await page.locator('#confirm-delete-project').click();
    await page.getByRole('heading', { name: '建立你的第一個專案' }).waitFor();
    assert.equal(
      (await page.evaluate(async () => (await window.studio.invoke('bootstrap')).projects)).length,
      0
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      'Responsive panels, searchable dropdowns, persisted sidebar width, drawer focus, project lifecycle, chosen device and throttled meter cleanup passed.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
