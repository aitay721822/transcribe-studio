const { _electron } = require('playwright');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');

async function themeCards(page, width) {
  assert.equal(await page.locator('[data-theme-option]').count(), 9);
  const cards = await page.locator('.theme-option').evaluateAll((elements) =>
    elements.map((element) => {
      const card = element.getBoundingClientRect();
      const swatch = element.querySelector('.theme-swatch').getBoundingClientRect();
      const label = element.querySelector('.theme-option-label').getBoundingClientRect();
      return {
        id: element.dataset.themeOption,
        card: { left: card.left, right: card.right },
        swatch: {
          left: swatch.left,
          right: swatch.right,
          width: swatch.width,
          bottom: swatch.bottom,
        },
        labelTop: label.top,
        overflow: element.scrollWidth > element.clientWidth + 1,
      };
    })
  );
  for (const card of cards) {
    assert(card.swatch.width >= 100, `${width} ${card.id}: preview must not collapse`);
    assert(card.swatch.bottom <= card.labelTop, `${width} ${card.id}: label must be below preview`);
    assert(card.swatch.left >= card.card.left && card.swatch.right <= card.card.right);
    assert.equal(card.overflow, false, `${width} ${card.id}: card overflow`);
  }
  await fs.mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: `output/playwright/appearance-${width}.png` });
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-settings-layout-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    const page = await app.firstWindow(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await require('../setup/helpers.cjs').overview(page);
    for (const [width, height] of [
      [1440, 900],
      [720, 760],
      [480, 540],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
        [width, height]
      );
      await page.waitForFunction((width) => innerWidth === width, width);
      if ((await page.locator('.settings-page').count()) === 0) {
        if (width <= 900) await page.locator('[data-action="collapse-sidebar"]').click();
        await page.locator('[data-view="settings"]').click();
      }
      for (const tab of ['asr', 'agent', 'mcp', 'appearance']) {
        await page.locator(`[data-settings-tab="${tab}"]`).click();
        assert.equal(await page.locator('.sidebar').count(), 0);
        assert(await page.getByRole('button', { name: '返回工作區', exact: true }).isVisible());
        assert.equal(await page.locator('.settings-actions').count(), 1);
        const bounds = await page.evaluate(() => {
          const nav = document.querySelector('.settings-nav').getBoundingClientRect(),
            content = document.querySelector('.settings-content').getBoundingClientRect(),
            layout = document.querySelector('.settings-layout').getBoundingClientRect();
          const footer = document.querySelector('.settings-actions'),
            main = document.querySelector('.main');
          return {
            navRight: nav.right,
            contentX: content.x,
            right: content.right,
            layoutRight: layout.right,
            footerColor: getComputedStyle(footer).backgroundColor,
            mainColor: getComputedStyle(main).backgroundColor,
            overflow:
              document.querySelector('.settings-scroll').scrollWidth >
              document.querySelector('.settings-scroll').clientWidth + 1,
            overflowing: [...document.querySelectorAll('.settings-scroll *')]
              .filter(
                (e) =>
                  e.getBoundingClientRect().right >
                  document.querySelector('.settings-scroll').getBoundingClientRect().right
              )
              .map((e) => [e.tagName, e.id, e.className, e.textContent.slice(0, 90)]),
          };
        });
        assert(bounds.navRight <= bounds.contentX + 1);
        assert(Math.abs(bounds.right - bounds.layoutRight) < 1);
        assert.equal(bounds.footerColor, bounds.mainColor);
        assert.equal(
          bounds.overflow,
          false,
          `${width} ${tab} content should not overflow: ${JSON.stringify(bounds.overflowing)}`
        );
        assert(await page.locator('[data-action="save-settings"]').isVisible());
        if (tab === 'mcp')
          assert(
            await page
              .locator('pre.code-field')
              .evaluateAll((pres) => pres.every((pre) => pre.scrollWidth <= pre.clientWidth + 1))
          );
        if (tab === 'appearance') await themeCards(page, width);
      }
      await page.locator('[data-settings-tab="mcp"]').click();
      await fs.mkdir('output/playwright', { recursive: true });
      await page.evaluate(() =>
        document.querySelectorAll('#toasts button').forEach((b) => b.click())
      );
      await page.screenshot({ path: `output/playwright/settings-layout-${width}.png` });
      if (width === 1440) {
        await page.locator('[data-settings-tab="appearance"]').click();
        for (const theme of [
          'light',
          'forest',
          'ocean',
          'slate',
          'sand',
          'rose',
          'lavender',
          'system',
        ]) {
          await page.locator(`[data-theme-option="${theme}"]`).click();
          assert.equal(
            await page.locator(`[data-theme-option="${theme}"]`).getAttribute('aria-pressed'),
            'true'
          );
          await page.locator('[data-action="save-settings"]').click();
          await page.waitForFunction(
            async (theme) => (await window.studio.invoke('bootstrap')).settings.theme === theme,
            theme
          );
          const scheme = await page.evaluate(
            () => getComputedStyle(document.documentElement).colorScheme
          );
          const nativeScheme = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
          if (theme !== 'system') assert.equal(nativeScheme, scheme);
        }
        await page.locator('[data-theme-option="dark"]').click();
        await page.locator('[data-action="save-settings"]').click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        await page.locator('[data-settings-tab="mcp"]').click();
        await page.evaluate(() =>
          document.querySelectorAll('#toasts button').forEach((b) => b.click())
        );
        await page.screenshot({ path: 'output/playwright/settings-layout-dark.png' });
      }
    }
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('[data-theme-option="ocean"]').click();
    await page.locator('[data-action="save-settings"]').click();
    await page.waitForFunction(
      async () => (await window.studio.invoke('bootstrap')).settings.theme === 'ocean'
    );
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'ocean');
    assert.deepEqual(errors, []);
    console.log(
      'Settings layout passed: persistent left categories, full-width right content, one matching-color footer, wrapped MCP JSON and desktop/compact layouts.'
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
