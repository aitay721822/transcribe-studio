const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function typography(page, label) {
  const problems = await page.evaluate(() => {
    const problems = [];

    const visible = (element) => {
      if (!element.getClientRects().length) return false;
      for (let e = element; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility !== 'visible' || s.opacity === '0') return false;
      }
      return true;
    };

    const check = (element, text, pseudo) => {
      const size = parseFloat(getComputedStyle(element, pseudo).fontSize);
      if (size < 16)
        problems.push({
          element: element.tagName,
          id: element.id,
          text: text.slice(0, 60),
          size,
          pseudo,
        });
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (
        node.textContent.trim() &&
        visible(node.parentElement) &&
        !['SCRIPT', 'STYLE'].includes(node.parentElement.tagName)
      )
        check(node.parentElement, node.textContent);
    }
    for (const element of document.querySelectorAll('input, textarea, select')) {
      if (!visible(element)) continue;
      check(element, element.value || element.placeholder || 'form');
      if (element.placeholder) check(element, element.placeholder, '::placeholder');
    }
    for (const element of document.querySelectorAll('*')) {
      if (!visible(element)) continue;
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(element, pseudo).content;
        if (content && !['none', 'normal', '""'].includes(content)) check(element, content, pseudo);
      }
    }
    return problems;
  });
  assert.deepEqual(problems, [], label);
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-fonts-'));
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
    await page.locator('.setup-page').waitFor();
    await typography(page, 'setup');
    await require('../setup/helpers.cjs').overview(page);
    await typography(page, 'overview');
    const id = await page.evaluate(async () => {
      const project = await window.studio.invoke('project:create', '可讀性測試專案');
      const meeting = await window.studio.invoke(
        'meeting:create',
        project.id,
        '字級與排版會議',
        'file'
      );
      await window.studio.invoke('meeting:update', meeting.id, {
        notes:
          '# 會議記錄\n### 待辦事項\n| 負責人 | 工作 |\n| --- | --- |\n| 設計團隊 | 確保文字清晰 |',
        chats: [{ text: '請整理這場會議。', createdAt: new Date().toISOString() }],
      });
      return { project: project.id, meeting: meeting.id };
    });
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    for (const [width, height] of [
      [1280, 900],
      [480, 540],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
        [width, height]
      );
      await page.waitForFunction((w) => innerWidth <= w, width);
      await page.locator(`.meeting-row[data-meeting="${id.meeting}"]`).click();
      for (const theme of ['light', 'dark', 'forest']) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await typography(page, `${width} workspace ${theme}`);
      }
      await page.locator('[data-editor-tab="preview"]').click();
      await typography(page, `${width} preview`);
      await page.locator('#agent-input').fill('@');
      await page.locator('.mention-menu').waitFor();
      await typography(page, `${width} reference menu`);
      await page.locator('#agent-input').press('Escape');
      await page.locator('[data-source-tab="audio"]').click();
      await typography(page, `${width} audio`);
      await page.locator('[data-action="export"]').click();
      await typography(page, `${width} export`);
      await page.locator('[data-close-modal]').click();
      await page.keyboard.press('Control+k');
      await page.locator('#palette-query').waitFor();
      await typography(page, `${width} search`);
      await page.keyboard.press('Escape');
      await page.locator('.breadcrumb-project').click();
      await typography(page, `${width} project menu`);
      await page.keyboard.press('Escape');
      if (width < 900) {
        await page.locator('[data-action="collapse-sidebar"]').click();
        await typography(page, 'drawer');
      }
      await page.locator(`[data-project="${id.project}"]`).click();
      await typography(page, `${width} project`);
      await page.locator('[data-action="rename-project"]').click();
      await typography(page, `${width} project editor`);
      const modal = await page.locator('#modal').boundingBox(),
        save = await page.locator('#name-confirm').boundingBox();
      assert(
        modal.x >= 0 && modal.x + modal.width <= width && save.y + save.height <= height,
        'project dialog controls fit'
      );
      await page.locator('#project-editor-cancel').click();
      await page.locator('[data-action="project-live"]').click();
      await typography(page, `${width} live`);
      await page.locator('#audio-device-trigger').click();
      await typography(page, `${width} dropdown`);
      await page.keyboard.press('Escape');
      await page.locator('[data-audio-mode="file"]').click();
      await typography(page, `${width} file source`);
      if (width < 900) await page.locator('[data-action="collapse-sidebar"]').click();
      await page.locator(`[data-project="${id.project}"]`).click();
      await page.locator('[data-action="project-import"]').click();
      await typography(page, `${width} import`);
      if (width < 900) await page.locator('[data-action="collapse-sidebar"]').click();
      await page.locator('[data-view="settings"]').click();
      for (const tab of ['asr', 'agent', 'mcp', 'appearance']) {
        await page.locator(`[data-settings-tab="${tab}"]`).click();
        await typography(page, `${width} settings ${tab}`);
      }
      await page.keyboard.press('Control+k');
      await page.locator('#palette-query').fill('字級');
      await page.keyboard.press('Enter');
      await page.locator('.workspace').waitFor();
      assert(
        await page.locator('#meeting-title').isVisible(),
        'meeting title remains visible at narrow widths'
      );
      await fs.mkdir('output/playwright', { recursive: true });
      await page.screenshot({ path: `output/playwright/typography-${width}.png` });
      // Return to the library for the next viewport without relying on hidden toolbar actions.
      await page.reload();
      await require('../setup/helpers.cjs').overview(page);
    }
    assert.deepEqual(errors, []);
    console.log(
      'Typography passed: every rendered text/form/placeholder/pseudo-element is >=16px across views, dialogs, menus, themes and 480px/1280px layouts.'
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
