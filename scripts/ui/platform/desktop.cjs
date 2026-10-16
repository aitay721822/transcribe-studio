const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store, DEFAULTS } = require('../../../dist/persistence/store.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-platform-ui-'));
  const store = new Store(path.join(profile, 'studio.sqlite'));
  const settings = structuredClone(DEFAULTS);
  settings.llm.apiKey = 'fixture-platform-key';
  settings.llm.model = 'fixture';
  settings.asr.fileUrl = 'http://127.0.0.1:1/transcriptions';
  store.saveSettings(settings);
  const project = store.createProject('Mac 相容性');
  const meeting = store.createMeeting(project.id, '快捷鍵');
  store.updateMeeting(meeting.id, { notes: '選取這段內容，先填寫回覆。' });
  store.close();
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.STUDIO_PACKAGED;
  const app = await _electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ['.'],
    env,
    timeout: 60000,
  });
  try {
    const page = await require('../setup/helpers.cjs').firstWindow(app);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.hero').waitFor();
    const permission = await page.evaluate(() => window.studio.invoke('media:status'));
    assert.equal(permission.platform, process.platform);
    if (process.platform === 'darwin') {
      const native = await app.evaluate(({ BrowserWindow, Menu }) => ({
        position: BrowserWindow.getAllWindows()[0].getTrafficLightPosition(),
        edit: Menu.getApplicationMenu().items.some(
          (item) => item.role?.toLowerCase() === 'editmenu'
        ),
      }));
      assert.deepEqual(native.position, { x: 16, y: 16 });
      assert.equal(native.edit, true);
    }
    // Exercise Mac presentation and DOM keyboard handling on every CI host; OS services are tested separately.
    await page.evaluate(() => {
      document.documentElement.dataset.platform = 'darwin';
    });
    await page.locator(`[data-project="${project.id}"]`).click();
    assert.equal(await page.locator('[data-action="project-live"] kbd').textContent(), '⌘⇧M');
    assert.equal(await page.locator('.window-controls').isVisible(), false);
    assert.ok(
      (await page
        .locator('.app-titlebar')
        .evaluate((element) => parseInt(getComputedStyle(element).paddingLeft, 10))) >= 86
    );
    await page.keyboard.press('Meta+Shift+i');
    await page.locator('#import-project').waitFor();
    assert.equal(await page.locator('#import-project').inputValue(), project.id);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.keyboard.press('Meta+Shift+m');
    await page.locator('#live-project').waitFor();
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    const editor = page.locator('#notes-editor');
    await editor.waitFor();
    await editor.evaluate((element) => {
      element.focus();
      element.setSelectionRange(0, 6);
      element.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await page.keyboard.press('Meta+Shift+m');
    await page.getByRole('textbox', { name: '回覆內容' }).waitFor();
    assert.equal(await page.locator('.reply-quote').count(), 0);
    await page.keyboard.press('Escape');
    await editor.fill('Mac Command S 儲存');
    await page.keyboard.press('Meta+s');
    assert.equal(
      await page.evaluate(
        async (id) => (await window.studio.invoke('meeting:get', id)).notes,
        meeting.id
      ),
      'Mac Command S 儲存'
    );
    assert.deepEqual(errors, []);
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/platform-mac-layout.png' });
    console.log(
      'Platform UI passed: Mac titlebar space, shortcuts and labels, reply staging, save, typed media status and native menu/traffic lights on macOS.'
    );
  } finally {
    await app.close();
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('studio-platform-ui-'));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
