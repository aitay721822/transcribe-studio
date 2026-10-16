const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-workspace-'));
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
    const meetingId = await page.evaluate(async () => {
      const p = await window.studio.invoke('project:create', '產品開發');
      const meeting = await window.studio.invoke('meeting:create', p.id, '產品週會', 'live');
      await window.studio.invoke('settings:save', { theme: 'dark' });
      return meeting.id;
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 950));
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator('[data-action="go-meetings"]').click();
    await page.locator(`.meeting-row[data-meeting="${meetingId}"]`).click();
    await page.locator('#notes-editor').waitFor();
    await page.locator('#notes-editor').fill('# 調整寬度時保留的筆記');
    await page.locator('#agent-input').fill('尚未送出的 Agent 指令');
    await page.evaluate(() => {
      window.__editorNode = document.querySelector('#notes-editor');
      window.__agentNode = document.querySelector('#agent-input');
    });
    const source = page.locator('#meeting-source');
    const agent = page.locator('#meeting-agent');

    const drag = async (name, delta) => {
      const bar = page.getByRole('separator', { name, exact: true });
      const box = await bar.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 160);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + 160, { steps: 12 });
      await page.mouse.up();
    };

    const initialSource = (await source.boundingBox()).width;
    await drag('調整會議來源寬度', 180);
    await page.waitForFunction(
      (width) =>
        document.querySelector('#meeting-source').getBoundingClientRect().width > width + 140,
      initialSource
    );
    const initialAgent = (await agent.boundingBox()).width;
    await drag('調整 Agent 助手寬度', -120);
    await page.waitForFunction(
      (width) =>
        document.querySelector('#meeting-agent').getBoundingClientRect().width > width + 90,
      initialAgent
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__editorNode === document.querySelector('#notes-editor') &&
          window.__agentNode === document.querySelector('#agent-input')
      ),
      true
    );
    assert.equal(await page.locator('#agent-input').inputValue(), '尚未送出的 Agent 指令');
    const keyboardBar = page.getByRole('separator', { name: '調整會議來源寬度', exact: true });
    const beforeKeyboard = (await source.boundingBox()).width;
    await keyboardBar.focus();
    await keyboardBar.press('ArrowLeft');
    await page.waitForFunction(
      (width) =>
        document.querySelector('#meeting-source').getBoundingClientRect().width < width - 1,
      beforeKeyboard
    );
    const layout = await page.evaluate(() => localStorage.getItem('studio.workspace.layout'));
    assert(layout);
    const saved = {
      source: (await source.boundingBox()).width,
      agent: (await agent.boundingBox()).width,
    };
    await page.locator('[data-source-tab="audio"]').click();
    assert(Math.abs((await source.boundingBox()).width - saved.source) < 3);
    await page.locator('[data-source-tab="transcript"]').click();
    await page.evaluate(() => {
      window.__editorNode = document.querySelector('#notes-editor');
      window.__agentNode = document.querySelector('#agent-input');
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 700));
    await page.locator('.workspace-stacked').waitFor();
    assert.equal(
      await page.evaluate(() => window.__editorNode === document.querySelector('#notes-editor')),
      true
    );
    assert.equal(await page.locator('#notes-editor').inputValue(), '# 調整寬度時保留的筆記');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('studio.workspace.layout')),
      layout
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 950));
    await page.waitForFunction(() => !document.querySelector('.workspace-stacked'));
    await page.waitForFunction(
      (percent) =>
        Math.abs(
          (document.querySelector('#meeting-source').getBoundingClientRect().width /
            (document.querySelector('.workspace').getBoundingClientRect().width - 10)) *
            100 -
            percent
        ) < 0.3,
      JSON.parse(layout)['meeting-source']
    );
    assert(
      Math.abs(
        ((await agent.boundingBox()).width /
          ((await page.locator('.workspace').boundingBox()).width - 10)) *
          100 -
          JSON.parse(layout)['meeting-agent']
      ) < 0.3
    );
    assert.equal(
      await page.evaluate(() => window.__editorNode === document.querySelector('#notes-editor')),
      true
    );
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/workspace-resized.png' });
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator('[data-action="go-meetings"]').click();
    await page.locator(`.meeting-row[data-meeting="${meetingId}"]`).click();
    await page.waitForFunction(
      (percent) =>
        Math.abs(
          (document.querySelector('#meeting-source').getBoundingClientRect().width /
            (document.querySelector('.workspace').getBoundingClientRect().width - 10)) *
            100 -
            percent
        ) < 0.3,
      JSON.parse(layout)['meeting-source']
    );
    assert(
      Math.abs(
        ((await agent.boundingBox()).width /
          ((await page.locator('.workspace').boundingBox()).width - 10)) *
          100 -
          JSON.parse(layout)['meeting-agent']
      ) < 0.3
    );
    assert.equal(await page.locator('#notes-editor').inputValue(), '# 調整寬度時保留的筆記');
    await drag('調整會議來源寬度', -2000);
    assert((await source.boundingBox()).width >= 299);
    await drag('調整 Agent 助手寬度', 2000);
    assert((await agent.boundingBox()).width >= 359);
    assert((await page.locator('#meeting-notes').boundingBox()).width >= 359);
    const controls = await page.locator('.prompt-chip, #meeting-source .tab').evaluateAll((nodes) =>
      nodes.map((node) => ({
        wraps: getComputedStyle(node).whiteSpace !== 'nowrap',
        overflows: node.scrollWidth > node.clientWidth + 1,
      }))
    );
    assert(controls.every((control) => !control.wraps && !control.overflows));
    await page.screenshot({ path: 'output/playwright/workspace-minimum-widths.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 950));
    await page.locator('.workspace-stacked').waitFor();
    assert.deepEqual(errors, []);
    console.log(
      'Workspace panels passed: both boundary drags, keyboard, resize without remounting inputs, tab/reload persistence, compact stack and desktop restoration.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
