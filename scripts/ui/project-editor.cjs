const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-editor-'));
  const folder = path.join(profile, 'EventCore');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'keep.txt'), '保留參考資料');
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    await require('./setup/helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await require('./setup/helpers.cjs').overview(page);
    await page.locator('[data-action="new-project"]').first().click();
    await page.locator('#name-input').fill('EventCore');
    await page.locator('#name-confirm').click();
    await page.getByRole('heading', { name: 'EventCore', exact: true }).waitFor();
    await app.evaluate(({ dialog }, folderPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folderPath, folderPath],
      });
    }, folder);

    const edit = () => page.locator('[data-action="rename-project"]').click();

    const add = () => page.locator('#project-editor-add').click();

    const roots = page.locator('.project-editor-root');

    const bootstrap = () => page.evaluate(() => window.studio.invoke('bootstrap'));

    await edit();
    await add();
    await roots.first().waitFor();
    assert.equal(await roots.count(), 1);
    assert.equal((await bootstrap()).projects[0].roots.length, 0);
    await page.locator('#name-input').fill('取消的名稱');
    await page.locator('#project-editor-cancel').click();
    assert.equal((await bootstrap()).projects[0].name, 'EventCore');
    assert.equal((await bootstrap()).projects[0].roots.length, 0);
    await edit();
    assert.equal(await roots.count(), 0);
    await add();
    await roots.first().waitFor();
    await page.locator('#name-confirm').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal((await bootstrap()).projects[0].roots.length, 1);
    await edit();
    await page.locator('[data-editor-remove-root]').click();
    await page.keyboard.press('Escape');
    assert.equal((await bootstrap()).projects[0].roots.length, 1);
    await edit();
    await add();
    assert.equal(await roots.count(), 1);
    await page.locator('#name-input').fill('');
    await page.locator('#name-confirm').click();
    await page.getByRole('alert').filter({ hasText: '請輸入專案名稱' }).waitFor();
    await page.locator('#name-input').fill('EventCore');
    await page.locator('#project-editor-cancel').click();
    await page.evaluate(async () => {
      const settings = (await window.studio.invoke('bootstrap')).settings;
      await window.studio.invoke('settings:save', { ...settings, theme: 'dark' });
      document.documentElement.dataset.theme = 'dark';
      document.querySelectorAll('#toasts button').forEach((button) => button.click());
    });
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0].setSize(1280, 900);
      shell.openPath = async (selectedPath) => {
        globalThis.__openedProjectFolder = selectedPath;
        return '';
      };
    });
    await page.waitForFunction(() => innerWidth >= 1200);
    const projectId = (await bootstrap()).projects[0].id;

    const projectMenu = () =>
      page.locator(`.project-row-actions [data-project-menu="${projectId}"]`).click();

    const menuItem = (name) => page.getByRole('menuitem', { name, exact: true });

    await projectMenu();
    for (const name of ['釘選專案', '編輯', '區段', '在檔案總管中開啟', '封存專案', '移除專案'])
      assert.equal(await menuItem(name).count(), 1);
    await menuItem('釘選專案').click();
    await page.locator('.pinned-projects .project-pin').waitFor();
    assert.equal(await page.locator('.regular-projects [data-project]').count(), 0);
    assert.equal(await page.locator(`[data-project="${projectId}"]`).count(), 1);
    assert.equal((await bootstrap()).projects[0].pinned, true);
    await projectMenu();
    await menuItem('區段').click();
    await menuItem('新增區段…').click();
    await page.locator('#name-input').fill('產品開發');
    await page.locator('#name-confirm').click();
    await page.waitForFunction(
      async (id) =>
        (await window.studio.invoke('bootstrap')).projects.find((p) => p.id === id).section ===
        '產品開發',
      projectId
    );
    assert.equal((await bootstrap()).projects[0].section, '產品開發');
    await page.reload();
    await page.locator('.project-pin').waitFor();
    await page.locator(`[data-project="${projectId}"]`).click();
    await projectMenu();
    await menuItem('在檔案總管中開啟').click();
    await page.waitForTimeout(100);
    assert.equal(
      await app.evaluate(() => globalThis.__openedProjectFolder),
      await fs.realpath(folder)
    );
    await page.locator('.breadcrumb-project').click();
    await menuItem('封存專案').click();
    await page.getByRole('button', { name: '解除封存', exact: true }).waitFor();
    assert.equal(await page.locator('.pinned-projects').count(), 0);
    await projectMenu();
    await menuItem('解除封存').click();
    await page.getByRole('button', { name: '封存專案', exact: true }).waitFor();
    await page.locator('.pinned-projects .project-pin').waitFor();
    await page.locator('.project-heading-menu').click();
    assert.equal(await menuItem('新增專案').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.project-context-menu').count(), 0);
    await projectMenu();
    await menuItem('移除專案').click();
    await page.locator('#cancel-delete-project').click();
    assert.equal((await bootstrap()).projects.length, 1);
    await page.locator(`[data-project-edit="${projectId}"]`).click();
    await page.getByRole('heading', { name: '編輯專案', exact: true }).waitFor();
    await page.locator('#project-editor-cancel').click();
    await projectMenu();
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '移除專案');
    await page.keyboard.press('Home');
    assert.equal(
      await page.evaluate(() => document.activeElement.textContent.trim()),
      '取消釘選專案'
    );
    await fs.mkdir('output/playwright', { recursive: true });
    await page
      .locator('.project-context-menu')
      .screenshot({ path: 'output/playwright/project-menu-dark.png' });
    await page.evaluate(() =>
      document.querySelectorAll('#toasts button').forEach((button) => button.click())
    );
    await page.screenshot({ path: 'output/playwright/project-sidebar-menu.png' });
    await page.keyboard.press('Escape');
    await page
      .locator('.pinned-projects')
      .screenshot({ path: 'output/playwright/pinned-project.png' });
    await projectMenu();
    await menuItem('取消釘選專案').click();
    await page.locator('.sidebar-section-label').filter({ hasText: '產品開發' }).waitFor();
    assert.equal(await page.locator(`.regular-projects [data-project="${projectId}"]`).count(), 1);
    await projectMenu();
    await menuItem('釘選專案').click();
    await page.locator('.pinned-projects .project-pin').waitFor();
    await projectMenu();
    await menuItem('區段').click();
    await menuItem('專案（預設）').click();
    await page.waitForFunction(() => !document.querySelector('.sidebar-section-label'));
    assert.equal((await bootstrap()).projects[0].section, '');
    await projectMenu();
    await menuItem('取消釘選專案').click();
    await page.waitForFunction(() => !document.querySelector('.project-pin'));
    assert.equal(await page.locator('.pinned-projects').count(), 0);
    assert.equal(await page.locator(`.regular-projects [data-project="${projectId}"]`).count(), 1);
    await edit();
    await page.locator('#name-input').focus();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.locator('#modal').screenshot({ path: 'output/playwright/project-editor-dark.png' });
    await page.screenshot({ path: 'output/playwright/project-editor-desktop.png' });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.locator('#modal').screenshot({ path: 'output/playwright/project-editor-light.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 540));
    await page.waitForFunction(() => innerWidth <= 480);
    const modalBox = await page.locator('#modal').boundingBox();
    assert(modalBox.x >= 0 && modalBox.x + modalBox.width <= 480);
    const saveBox = await page.locator('#name-confirm').boundingBox();
    assert(saveBox.x + saveBox.width <= 480 && saveBox.y + saveBox.height <= 540);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({ path: 'output/playwright/project-editor-mobile.png' });
    await page.locator('[data-editor-remove-root]').click();
    await page.locator('#name-input').fill('更新後的專案');
    await page.keyboard.press('Enter');
    await page.locator('#modal').waitFor({ state: 'hidden' });
    const saved = (await bootstrap()).projects[0];
    assert.equal(saved.name, '更新後的專案');
    assert.equal(saved.roots.length, 0);
    assert.equal(await fs.readFile(path.join(folder, 'keep.txt'), 'utf8'), '保留參考資料');
    await page.locator('.breadcrumb-project').click();
    assert.equal(await menuItem('在檔案總管中開啟').isDisabled(), true);
    const menuBox = await page.locator('.project-context-menu').boundingBox();
    assert(menuBox.x >= 0 && menuBox.x + menuBox.width <= 480);
    assert(menuBox.y >= 0 && menuBox.y + menuBox.height <= 540);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="collapse-sidebar"]').click();
    await page.locator('.drawer-open').waitFor();
    await projectMenu();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.drawer-open').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.drawer-open'));
    await edit();
    await page.locator('#project-editor-remove').click();
    await page.locator('#cancel-delete-project').click();
    assert.equal((await bootstrap()).projects.length, 1);
    assert.deepEqual(errors, []);
    console.log(
      'Project editor/menu: staged folders, pin/section persistence, Explorer, archive/restore, delete confirmation, keyboard, themes and compact drawer passed.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
