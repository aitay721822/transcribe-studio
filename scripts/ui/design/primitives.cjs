const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-primitives-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    const page = await require('../setup/helpers.cjs').desktopWindow(app);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.locator('.setup-page').waitFor();
    assert.equal(await page.locator('#setup-asr-file-key').getAttribute('data-slot'), 'input');
    assert.equal(await page.locator('#setup-next').getAttribute('data-slot'), 'button');
    assert(
      await page
        .locator('#setup-next')
        .evaluate(
          (button) =>
            button.classList.contains('inline-flex') &&
            ['flex', 'inline-flex'].includes(getComputedStyle(button).display)
        )
    );
    await page.locator('#setup-asr-file-key').focus();
    assert.equal(
      await page
        .locator('#setup-asr-file-key')
        .evaluate((input) => getComputedStyle(input).outlineWidth),
      '2px'
    );
    await page.locator('#setup-asr-realtime-tab').click();
    const checkbox = page.getByRole('checkbox', { name: '啟用即時辨識', exact: true });
    assert.equal(await checkbox.getAttribute('data-slot'), 'checkbox');
    await fs.mkdir('output/playwright', { recursive: true });
    for (const theme of ['light', 'dark', 'forest']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await checkbox.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const unchecked = await checkbox.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      await checkbox.focus();
      await page.keyboard.press('Space');
      await checkbox.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(await checkbox.getAttribute('data-state'), 'checked');
      assert(await checkbox.locator('[data-slot="checkbox-indicator"]').isVisible());
      const appearance = await checkbox.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          radius: style.borderRadius,
          outline: style.outlineWidth,
        };
      });
      assert.notEqual(appearance.background, unchecked);
      assert.equal(appearance.radius, '4px');
      assert.equal(appearance.outline, '2px');
      await page.screenshot({ path: `output/playwright/shadcn-checkbox-${theme}.png` });
      await page.keyboard.press('Enter');
      assert.equal(
        await checkbox.isChecked(),
        true,
        'Enter does not submit or toggle the checkbox'
      );
      await page.getByText('啟用即時辨識', { exact: true }).click();
      assert.equal(await checkbox.isChecked(), false, 'The surrounding label toggles the control');
    }
    await page.locator('#setup-asr-offline-tab').click();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator('[data-action="new-project"]').click();
    assert.equal(await page.locator('#name-input').getAttribute('data-slot'), 'input');
    assert.equal(await page.locator('#name-confirm').getAttribute('data-slot'), 'button');
    await page.locator('#name-input').fill('Shadcn controls');
    await page.locator('#name-confirm').click();
    await page.locator('.project-overview').waitFor();
    const id = await page.evaluate(async () => {
      const data = await window.studio.invoke('bootstrap');
      const meeting = await window.studio.invoke(
        'meeting:create',
        data.projects[0].id,
        '<img src=x onerror="throw 1">',
        'file'
      );
      return meeting.id;
    });
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`.meeting-row[data-meeting="${id}"]`).click();
    assert.equal(await page.locator('#notes-editor').getAttribute('data-slot'), 'textarea');
    assert.equal(
      await page.locator('#meeting-title').inputValue(),
      '<img src=x onerror="throw 1">'
    );
    assert.equal(await page.locator('.main img').count(), 0);
    await page.locator('#notes-editor').fill('# Literal <h1>content</h1>');
    await page.keyboard.press('Control+s');
    await page.locator('[data-editor-tab="preview"]').click();
    assert.match(
      await page.locator('.document-preview').textContent(),
      /Literal <h1>content<\/h1>/
    );
    assert.equal(await page.locator('.document-preview h1 h1').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Tailwind/shadcn passed: real React primitives on pages/dialogs, built utility CSS, focus, form values, escaped content and Markdown preview.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
