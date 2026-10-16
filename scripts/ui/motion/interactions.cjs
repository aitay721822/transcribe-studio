const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { desktopWindow, overview } = require('../setup/helpers.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-motion-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    const page = await desktopWindow(app);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#setup-asr-file-model').fill('保留離線草稿');
    await page.getByRole('tab', { name: '即時辨識（選用）' }).click();
    const realtime = page.locator('#setup-asr-realtime-panel');
    assert.equal(
      await realtime.evaluate((el) => getComputedStyle(el).animationName),
      'studio-content-enter'
    );
    await page.getByRole('tab', { name: '離線辨識（必填）' }).click();
    assert.equal(await page.locator('#setup-asr-file-model').inputValue(), '保留離線草稿');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('tab', { name: '即時辨識（選用）' }).click();
    assert.equal(await realtime.evaluate((el) => getComputedStyle(el).animationName), 'none');
    await overview(page);
    for (const reduced of [false, true]) {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.locator('[data-action="new-project"]').first().click();
      const modal = page.locator('#modal');
      assert.equal(
        await modal.evaluate((el) => getComputedStyle(el).animationName),
        reduced ? 'none' : 'studio-surface-enter'
      );
      await page.locator('#name-input').fill(reduced ? '靜態專案' : '動態專案');
      await page.locator('#name-confirm').click();
      await modal.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => {
        const view = document.querySelector('[data-motion="reveal"].motion-view');
        return view && getComputedStyle(view).opacity === '1';
      });
      await page.locator('#toasts button').first().click();
      await page.locator('#toasts .toast').waitFor({ state: 'detached' });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 800));
    await page.waitForFunction(() => innerWidth === 600);
    for (const reduced of [false, true]) {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.locator('[data-action="collapse-sidebar"]').click();
      await page.waitForFunction(() => {
        const panel = document.querySelector('#project-navigation');
        return (
          panel.getBoundingClientRect().x >= 0 && getComputedStyle(panel).visibility === 'visible'
        );
      });
      const transition = await page
        .locator('#project-navigation')
        .evaluate((el) => getComputedStyle(el).transitionDuration);
      assert.equal(
        transition.split(',').some((value) => parseFloat(value) > 0),
        !reduced
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#project-navigation')).visibility === 'hidden'
      );
      assert.equal(await page.locator('.main-slot').getAttribute('inert'), null);
    }
    assert.deepEqual(errors, []);
    console.log(
      'Motion passed: tab drafts survive, native dialogs animate, route fades finish, notifications exit, drawer focus/inert and live reduced-motion preferences work.'
    );
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
