const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-react-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    await require('../setup/helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await require('../setup/helpers.cjs').overview(page);
    const ids = await page.evaluate(async () => {
      const p = await window.studio.invoke('project:create', 'React workflow');
      const a = await window.studio.invoke('meeting:create', p.id, '第一場', 'file');
      const b = await window.studio.invoke('meeting:create', p.id, '第二場', 'file');
      await window.studio.invoke('meeting:update', b.id, { notes: '第二場筆記' });
      return { project: p.id, first: a.id, second: b.id };
    });
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`.meeting-row[data-meeting="${ids.first}"]`).click();
    await page.locator('#notes-editor').fill('尚在撰寫的筆記，保留文字與選取範圍。');
    await page.locator('#notes-editor').press('Home');
    await page.locator('#notes-editor').press('Shift+ArrowRight');
    await page.locator('#notes-editor').press('Shift+ArrowRight');
    await page.locator('#agent-input').fill('尚未送出的 Agent 指令');
    await page.waitForFunction(() =>
      document.querySelector('#save-status').textContent.includes('已儲存')
    );
    const before = await page.evaluate(() => {
      window.notesBefore = document.querySelector('#notes-editor');
      window.composerBefore = document.querySelector('#agent-input');
      return {
        notes: window.notesBefore.value,
        start: window.notesBefore.selectionStart,
        end: window.notesBefore.selectionEnd,
      };
    });

    const emit = (channel, event) =>
      app.evaluate(
        ({ BrowserWindow }, data) =>
          BrowserWindow.getAllWindows()[0].webContents.send(data.channel, data.event),
        { channel, event }
      );

    await emit('asr:event', {
      type: 'segment',
      meetingId: ids.first,
      segment: { id: 'stream-1', start: 0, end: 1, text: '即時串流片段', final: false },
    });
    await page.locator('.segment p').filter({ hasText: '即時串流片段' }).waitFor();
    await emit('asr:event', {
      type: 'segment',
      meetingId: ids.first,
      segment: { id: 'stream-1', start: 0, end: 1, text: '修正後的串流片段', final: true },
    });
    await page.locator('.segment p').filter({ hasText: '修正後的串流片段' }).waitFor();
    assert.equal(await page.locator('.segment').count(), 1);
    await emit('agent:event', { type: 'started', meetingId: ids.first, runId: 'react-run' });
    await page.locator('[data-action="cancel-agent"]').waitFor();
    await emit('agent:event', {
      type: 'input-state',
      meetingId: ids.first,
      args: {
        activeRunId: 'react-run',
        queued: [{ id: 'queued-1', instruction: '下一輪指令' }],
        paused: false,
      },
    });
    await page.locator('.agent-queue-item').filter({ hasText: '下一輪指令' }).waitFor();
    await emit('agent:event', {
      type: 'log',
      meetingId: ids.first,
      runId: 'react-run',
      message: '正在整理',
    });
    await page.locator('.agent-log').filter({ hasText: '正在整理' }).waitFor();
    const after = await page.evaluate(() => ({
      sameNotes: document.querySelector('#notes-editor') === window.notesBefore,
      sameComposer: document.querySelector('#agent-input') === window.composerBefore,
      notes: window.notesBefore.value,
      start: window.notesBefore.selectionStart,
      end: window.notesBefore.selectionEnd,
    }));
    assert.equal(after.sameNotes, true);
    assert.equal(after.sameComposer, true);
    assert.deepEqual({ notes: after.notes, start: after.start, end: after.end }, before);
    assert.equal(await page.locator('#agent-input').inputValue(), '尚未送出的 Agent 指令');
    const version = await page.evaluate(
      async (id) => (await window.studio.invoke('meeting:get', id)).version,
      ids.first
    );
    await emit('agent:event', {
      type: 'proposal',
      meetingId: ids.first,
      notes: '# React 修訂\n已套用的新筆記。',
      version,
    });
    await page.locator('[data-action="review-proposal"]').click();
    await page.locator('#accept-proposal').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(
      await page.locator('#notes-editor').inputValue(),
      '# React 修訂\n已套用的新筆記。'
    );
    assert.equal(await page.locator('#agent-input').inputValue(), '尚未送出的 Agent 指令');
    await page.locator(`.meeting-link[data-meeting="${ids.second}"]`).click();
    await page.waitForFunction(() => document.querySelector('#meeting-title')?.value === '第二場');
    assert.equal(await page.locator('#meeting-title').inputValue(), '第二場');
    assert.equal(await page.locator('#notes-editor').inputValue(), '第二場筆記');
    assert.equal(await page.locator('#agent-input').inputValue(), '');
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/react-workspace.png' });
    assert.deepEqual(errors, []);
    console.log(
      'React continuity passed: streamed transcript replacement, stable editor/selection/composer, agent queue updates, applied proposal and meeting switching.'
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
