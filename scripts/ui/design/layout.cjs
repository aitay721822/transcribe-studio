const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { desktopWindow, overview, resizeWindow } = require('../setup/helpers.cjs');

async function sidebarLayout(page, ids) {
  const projects = await page.locator('.project-sidebar-row').evaluateAll(
    (rows, ids) =>
      rows
        .filter((row) => ids.includes(row.querySelector('[data-project]')?.dataset.project))
        .map((row) => {
          const button = row.querySelector('[data-project]');
          const title = button.querySelector('.project-name');
          const folder = button.querySelector('.icon');
          const actions = row.querySelector('.project-row-actions');
          const box = title.getBoundingClientRect();
          const meeting = document.querySelector(
            `#project-meetings-${button.dataset.project} .meeting-link`
          );
          const range = document.createRange();
          range.setStart(meeting.firstChild, 0);
          range.setEnd(meeting.firstChild, 1);
          return {
            meetingStart: range.getBoundingClientRect().x,
            meetingEllipsis: getComputedStyle(meeting).textOverflow,
            title: box.x,
            folder: folder.getBoundingClientRect().x,
            right: box.right,
            actions: actions.getBoundingClientRect().left,
            overflow: title.scrollWidth > title.clientWidth,
            ellipsis: getComputedStyle(title).textOverflow,
          };
        }),
    ids
  );
  assert.equal(projects.length, ids.length);
  assert(
    Math.max(...projects.map((row) => row.folder)) -
      Math.min(...projects.map((row) => row.folder)) <
      1,
    'Folder icons align for short and long project names'
  );
  assert(
    Math.max(...projects.map((row) => row.title)) - Math.min(...projects.map((row) => row.title)) <
      1,
    'Project titles align for short and long project names'
  );
  assert(
    projects.every((row) => row.right <= row.actions + 1),
    'Project names never overlap actions'
  );
  assert(projects.at(-1).overflow && projects.at(-1).ellipsis === 'ellipsis');
  assert(
    projects.every((row) => Math.abs(row.meetingStart - row.title) < 2),
    'Meeting titles align with project titles'
  );
  assert(projects.every((row) => row.meetingEllipsis === 'ellipsis'));
  const settingsInset = await page
    .locator('.sidebar [data-view="settings"]')
    .evaluate(
      (button) =>
        button.querySelector('svg').getBoundingClientRect().left -
        button.getBoundingClientRect().left
    );
  assert(settingsInset <= 12, 'The settings navigation stays left aligned');
}

async function dropzoneLayout(page, variant, width, theme) {
  const dropzone = page.locator('.dropzone');
  await dropzone.waitFor();
  const geometry = await dropzone.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      fits: element.scrollWidth <= element.clientWidth + 1,
      wraps: getComputedStyle(element).whiteSpace !== 'nowrap',
      pageFits:
        document.querySelector('.main').scrollWidth <=
        document.querySelector('.main').clientWidth + 1,
      childrenFit: [...element.children].every((child) => {
        const rect = child.getBoundingClientRect();
        return rect.left >= box.left && rect.right <= box.right;
      }),
    };
  });
  assert(
    geometry.fits && geometry.wraps && geometry.childrenFit && geometry.pageFits,
    `${variant} dropzone fits at ${width}px in ${theme}: ${JSON.stringify(geometry)}`
  );
  assert(
    await page
      .locator('.selected-file')
      .evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth + 1)),
    'Long filenames remain inside their selected-file rows'
  );
  if ([1280, 480].includes(width))
    await page.screenshot({ path: `output/playwright/layout-${variant}-${width}-${theme}.png` });
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-layout-'));
  const selectedFile = path.join(profile, `${'LongRecordingWithoutSpaces'.repeat(4)}.txt`);
  await fs.writeFile(selectedFile, '匯入版面測試');
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
    page.on('pageerror', (error) => errors.push(error.message));
    await overview(page);
    const ids = await page.evaluate(async () => {
      const ids = [];
      for (const title of [
        '測試',
        '測試擷取電腦',
        '很長的專案名稱用來驗證側欄縮排與省略號不會擠到右側操作選單',
      ]) {
        const project = await window.studio.invoke('project:create', title);
        await window.studio.invoke(
          'meeting:create',
          project.id,
          '臺北大巨蛋 7 與這是一段非常長而且不能擠出側欄的會議標題',
          'file'
        );
        ids.push(project.id);
      }
      return ids;
    });
    await page.reload();
    await overview(page);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, selectedFile);
    let picked = false;
    await fs.mkdir('output/playwright', { recursive: true });
    for (const theme of ['light', 'dark', 'forest']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (const width of [1530, 1280, 1100, 900, 600, 480]) {
        await resizeWindow(app, page, width, 900);
        await page.waitForFunction((value) => {
          const compact = value <= 900;
          return document.querySelector('.shell').classList.contains('compact-shell') === compact;
        }, width);
        if (!(await page.locator('.sidebar').isVisible()))
          await page.getByRole('button', { name: '展開專案側欄', exact: true }).click();
        await page.waitForFunction(() => {
          const box = document.querySelector('.sidebar').getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth;
        });
        for (const id of ids) {
          const toggle = page.locator(`[data-project-toggle="${id}"]`);
          if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        }
        await sidebarLayout(page, ids);
        if ([1280, 480].includes(width))
          await page
            .locator('.sidebar')
            .screenshot({ path: `output/playwright/layout-sidebar-${width}-${theme}.png` });
        await page.locator(`.sidebar [data-project="${ids[0]}"]`).click();
        await page.locator('[data-action="project-import"]').click();
        if (!picked) {
          await page.locator('[data-action="pick-files"]').click();
          await page.locator('.selected-file').waitFor();
          picked = true;
        }
        await dropzoneLayout(page, 'import', width, theme);
        if (!(await page.locator('.sidebar').isVisible()))
          await page.getByRole('button', { name: '展開專案側欄', exact: true }).click();
        await page.locator(`.sidebar [data-project="${ids[0]}"]`).click();
        await page.locator('[data-action="project-live"]').click();
        await page.locator('[data-audio-mode="file"]').click();
        await dropzoneLayout(page, 'live-file', width, theme);
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      'Layout regression passed: sidebar alignment/ellipsis/action bounds and both upload areas without overflow across six window widths and all three themes.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
