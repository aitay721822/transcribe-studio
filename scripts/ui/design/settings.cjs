const { _electron } = require('playwright');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');

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
      }
      await page.locator('[data-settings-tab="mcp"]').click();
      await fs.mkdir('output/playwright', { recursive: true });
      await page.evaluate(() =>
        document.querySelectorAll('#toasts button').forEach((b) => b.click())
      );
      await page.screenshot({ path: `output/playwright/settings-layout-${width}.png` });
      if (width === 1440) {
        await page.locator('[data-settings-tab="appearance"]').click();
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
