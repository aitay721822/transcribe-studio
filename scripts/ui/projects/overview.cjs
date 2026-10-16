const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-overview-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    await require('../setup/helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await require('../setup/helpers.cjs').overview(page);
    const fixture = await page.evaluate(async () => {
      const p = await window.studio.invoke('project:create', '產品開發');
      const other = await window.studio.invoke('project:create', '其他專案');
      const first = await window.studio.invoke('meeting:create', p.id, '產品週會', 'live');
      await window.studio.invoke(
        'meeting:update',
        first.id,
        { notes: '# 產品決議', status: 'completed' },
        first.version
      );
      await window.studio.invoke('meeting:create', p.id, '客戶需求訪談', 'file');
      for (let index = 0; index < 10; index += 1) {
        await window.studio.invoke('meeting:create', p.id, `分頁會議 ${index}`, 'live');
      }
      await window.studio.invoke('meeting:create', other.id, '其他專案的會議', 'live');
      await window.studio.invoke('settings:save', { theme: 'dark' });
      return { id: p.id, otherId: other.id };
    });
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-project="${fixture.id}"]`).click();
    await page.getByRole('heading', { name: '產品開發', exact: true }).waitFor();
    await page.getByRole('heading', { name: '總覽', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.project-overview-stat strong').allTextContents(), [
      '12',
      '0',
      '1',
      '0',
    ]);
    const rows = page.locator('.project-overview .meeting-row');
    const more = page.locator('.project-overview').getByRole('button', { name: '顯示更多' });
    assert.equal(await rows.count(), 5);
    await more.click();
    assert.equal(await rows.count(), 10);
    await more.click();
    assert.equal(await rows.count(), 12);
    assert.equal(await more.count(), 0);
    assert.equal(await page.locator('.project-overview').getByText('其他專案的會議').count(), 0);
    const toggle = page.locator(`[data-project-toggle="${fixture.id}"]`);
    const children = page.locator(`#project-meetings-${fixture.id}`);
    const sidebarMeetings = children.locator('[data-meeting]');
    const sidebarMore = children.getByRole('button', { name: '顯示更多' });
    assert.equal(await sidebarMeetings.count(), 5);
    await sidebarMore.click();
    assert.equal(await sidebarMeetings.count(), 10);
    await sidebarMore.click();
    assert.equal(await sidebarMeetings.count(), 12);
    assert.equal(await sidebarMore.count(), 0);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await children.getAttribute('inert'), '');
    await page.waitForFunction(
      (id) =>
        document.getElementById(`project-meetings-${id}`).getBoundingClientRect().height === 0,
      fixture.id
    );
    await page.getByRole('heading', { name: '總覽', exact: true }).waitFor();
    await page.reload();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(
      (id) => document.getElementById(`project-meetings-${id}`).getBoundingClientRect().height > 50,
      fixture.id
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await children.evaluate((element) => getComputedStyle(element).transitionDuration),
      '0s'
    );
    await page.keyboard.press('Enter');
    assert.equal(await children.boundingBox().then((box) => box.height), 0);
    const otherToggle = page.locator(`[data-project-toggle="${fixture.otherId}"]`);
    await otherToggle.click();
    assert.equal(await otherToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator(`[data-project="${fixture.id}"]`).click();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/project-overview-dark.png' });
    await page.locator('[data-action="project-live"]').click();
    await page.getByRole('heading', { name: '即時會議', exact: true }).waitFor();
    assert.equal(await page.locator('#live-project').inputValue(), fixture.id);
    await page.locator(`[data-project="${fixture.id}"]`).click();
    await page.locator('[data-action="project-import"]').click();
    await page.getByRole('heading', { name: '音檔辨識', exact: true }).waitFor();
    assert.equal(await page.locator('#import-project').inputValue(), fixture.id);
    await page.locator(`[data-project="${fixture.id}"]`).click();
    await page.keyboard.press('Control+Alt+m');
    await page.locator('#live-project').waitFor();
    assert.equal(await page.locator('#live-project').inputValue(), fixture.id);
    await page.locator(`[data-project="${fixture.id}"]`).click();
    await page.keyboard.press('Control+Alt+i');
    await page.locator('#import-project').waitFor();
    assert.equal(await page.locator('#import-project').inputValue(), fixture.id);
    await page.locator(`[data-project="${fixture.otherId}"]`).click();
    await page.getByRole('heading', { name: '其他專案', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.project-overview-stat strong').allTextContents(), [
      '1',
      '0',
      '0',
      '0',
    ]);
    await page.locator(`[data-project="${fixture.id}"]`).click();
    await page.locator('[data-action="archive-project"]').click();
    await page.getByRole('button', { name: '解除封存', exact: true }).waitFor();
    assert.equal(await page.locator('[data-action="project-live"]').isDisabled(), true);
    assert.equal(await page.locator('[data-action="project-import"]').isDisabled(), true);
    await page.locator('[data-action="archive-project"]').click();
    await page.getByRole('button', { name: '封存專案', exact: true }).waitFor();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.querySelectorAll('#toasts button').forEach((button) => button.click());
    });
    await page.screenshot({ path: 'output/playwright/project-overview-light.png' });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 650));
    await page.waitForFunction(() => innerWidth <= 480);
    for (const action of ['project-live', 'project-import']) {
      const box = await page.locator(`[data-action="${action}"]`).boundingBox();
      assert(box.x >= 0 && box.x + box.width <= 480);
    }
    await page.screenshot({ path: 'output/playwright/project-overview-mobile.png' });
    await page.locator('[data-action="project-live"]').click();
    await page.locator('#live-project').waitFor();
    assert.equal(await page.locator('#live-project').inputValue(), fixture.id);
    assert.deepEqual(errors, []);
    console.log(
      'Project overview passed: independent project collapse, persistence, keyboard and reduced motion, scoped counts/recent meetings, buttons and keyboard shortcuts preserve project, archive guards, themes and RWD.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
