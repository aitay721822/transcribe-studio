const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-search-'));
  const referenceFolder = path.join(profile, 'references');
  await fs.mkdir(referenceFolder);
  await fs.writeFile(path.join(referenceFolder, 'hello.md'), '# 專案參考資料');
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
    await page.locator('[data-action="search"]').first().click();
    const query = page.locator('#palette-query');
    await query.waitFor();
    assert.equal(await query.evaluate((element) => document.activeElement === element), true);
    await page.getByText('還沒有會議，從下方開始新增').waitFor();
    await page.keyboard.press('Escape');
    const fixture = await page.evaluate(async () => {
      const p = await window.studio.invoke('project:create', 'Transcribe Studio');
      const other = await window.studio.invoke('project:create', 'EventCore');
      const titles = [
        '工程站會',
        '產品週會',
        '客戶訪談：API 與資料安全',
        '更新文件並統整待修正項目',
        '規劃剩餘 API 實現流程',
        '檢查 OIDC 流程完整性',
        '年度供應商大會',
        '行銷腦力激盪',
        '財務月結檢討',
        '第十場舊會議',
      ];
      const meetings = [];
      for (let i = 0; i < titles.length; i++) {
        const m = await window.studio.invoke(
          'meeting:create',
          i === 2 ? other.id : p.id,
          titles[i],
          'live'
        );
        const saved = await window.studio.invoke(
          'meeting:update',
          m.id,
          {
            notes: i === 2 ? '# 決議\n唯一預算關鍵詞，需要補充需求規格' : '# 會議紀錄',
            updatedAt: new Date(Date.UTC(2020, 9, 14, 12, 0, 10 - i)).toISOString(),
            segments:
              i === 3 ? [{ id: 'seg1', text: '逐字稿專用詞', start: 0, end: 5, final: true }] : [],
            chats: i === 4 ? [{ text: '對話專用詞', createdAt: new Date().toISOString() }] : [],
          },
          m.version
        );
        meetings.push(saved);
      }
      await window.studio.invoke('settings:save', { theme: 'dark' });
      return { projectId: p.id, meetings };
    });
    await app.evaluate(
      ({ app }, { meetings, referenceFolder }) => {
        const require = process
          .getBuiltinModule('module')
          .createRequire(`${app.getAppPath()}/package.json`);
        const { DatabaseSync } = require('node:sqlite');
        const path = require('node:path');

        const db = new DatabaseSync(path.join(app.getPath('userData'), 'studio.sqlite'));
        try {
          for (const row of db.prepare('SELECT id, data FROM projects').all()) {
            const project = JSON.parse(row.data);
            project.roots = [
              { id: 'fixture-root', path: referenceFolder, name: 'references', mode: 'readonly' },
            ];
            db.prepare('UPDATE projects SET data=? WHERE id=?').run(
              JSON.stringify(project),
              row.id
            );
          }
          meetings.forEach((meeting, index) => {
            const data = JSON.parse(
              db.prepare('SELECT data FROM meetings WHERE id=?').get(meeting.id).data
            );
            data.updatedAt = new Date(Date.UTC(2020, 9, 14, 12, 0, 10 - index)).toISOString();
            if (index === 3)
              data.segments = [{ id: 'seg1', text: '逐字稿專用詞', start: 0, end: 5, final: true }];
            db.prepare('UPDATE meetings SET data=? WHERE id=?').run(
              JSON.stringify(data),
              meeting.id
            );
          });
        } finally {
          db.close();
        }
      },
      { meetings: fixture.meetings, referenceFolder }
    );
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.keyboard.press('Control+k');
    await query.waitFor();
    assert.equal(
      await page.locator('#palette-results .palette-result:not(.palette-quick)').count(),
      9
    );
    assert.equal(await page.locator('#palette-results .palette-quick').count(), 3);
    await fs.mkdir('output/playwright', { recursive: true });
    await page.locator('#search-palette').screenshot({ path: 'output/playwright/search-dark.png' });
    await page.screenshot({ path: 'output/playwright/search-desktop.png' });
    await query.fill('唯一預算關鍵詞');
    assert.equal(await page.locator('#palette-results [role="option"]').count(), 1);
    await page.getByRole('option', { name: /客戶訪談/ }).waitFor();
    await query.press('Enter');
    await page.locator('#meeting-title').waitFor();
    assert.equal(await page.locator('#meeting-title').inputValue(), fixture.meetings[2].title);
    await page.locator('#notes-editor').fill('# 搜尋前尚未儲存的筆記');
    await page.keyboard.press('Control+k');
    await query.fill('逐字稿專用詞');
    await page.getByRole('option', { name: /更新文件/ }).waitFor();
    await query.fill('對話專用詞');
    await page.getByRole('option', { name: /規劃剩餘/ }).waitFor();
    await query.fill('EventCore API');
    assert.equal(await page.locator('#palette-results [role="option"]').count(), 1);
    await query.fill('不存在的搜尋結果');
    await page.getByText('沒有符合的會議', { exact: true }).waitFor();
    assert.equal(await page.locator('#palette-results [role="option"]').count(), 0);
    await query.press('Enter');
    assert.equal(await page.locator('#search-palette').count(), 1);
    await query.fill('');
    await query.press('ArrowDown');
    assert.equal(await page.locator('#palette-results [aria-selected="true"]').count(), 1);
    const arrowTitle = await page
      .locator('#palette-results [aria-selected="true"] .palette-result-title')
      .textContent();
    await query.press('Enter');
    await page.waitForFunction(
      (title) => document.querySelector('#meeting-title')?.value === title,
      arrowTitle
    );
    const saved = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      fixture.meetings[2].id
    );
    assert.match(saved.notes, /尚未儲存的筆記/);
    await page.keyboard.press('Control+k');
    await query.waitFor();
    const altTitle = await page
      .locator('#palette-results .palette-result-title')
      .first()
      .textContent();
    await page.keyboard.press('Alt+1');
    await page.waitForFunction(
      (title) => document.querySelector('#meeting-title')?.value === title,
      altTitle
    );
    await page.keyboard.press('Control+k');
    await query.waitFor();
    await page.keyboard.press('Control+n');
    await page.getByRole('heading', { name: '新增會議', exact: true }).waitFor();
    await page.locator('#name-cancel').click();
    await page.keyboard.press('Control+k');
    await query.waitFor();
    await page.keyboard.press('Control+o');
    await page.getByRole('heading', { name: '編輯專案', exact: true }).waitFor();
    await page.locator('#project-editor-cancel').click();
    await page.keyboard.press('Control+k');
    await query.waitFor();
    await page.keyboard.press('Control+p');
    await page.locator('#file-search').waitFor();
    assert.equal(
      await page.locator('#file-search').evaluate((element) => document.activeElement === element),
      true
    );
    const trigger = page.locator('.search-button');
    await page.locator('#file-search').fill('hello');
    await page.locator('#project-files button').filter({ hasText: 'hello.md' }).click();
    await page.locator('#project-file-preview').waitFor();
    assert.equal(await page.locator('#project-file-preview').textContent(), '# 專案參考資料');
    await page.locator('[data-close-modal]').click();
    await trigger.click();
    await query.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
    await trigger.click();
    await query.waitFor();
    await page.mouse.click(5, 50);
    assert.equal(await page.locator('#search-palette').count(), 0);
    await page.keyboard.press('Control+k');
    await query.waitFor();
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('#search-palette').count(), 0);
    await page.keyboard.press('Control+k');
    await query.waitFor();
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page
      .locator('#search-palette')
      .screenshot({ path: 'output/playwright/search-light.png' });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 540));
    await page.waitForFunction(() => innerWidth <= 480);
    const box = await page.locator('#search-palette').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 480 && box.y >= 0 && box.y + box.height <= 540);
    await query.fill('EventCore');
    await page
      .locator('#search-palette')
      .screenshot({ path: 'output/playwright/search-mobile.png' });
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(
      'Search palette passed: full-text/project matching, recent limit, dirty notes, navigation, Alt shortcuts, quick actions, empty states, focus, themes and RWD.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
