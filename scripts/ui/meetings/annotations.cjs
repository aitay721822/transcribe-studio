const { _electron } = require('playwright');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');

async function main() {
  const requests = [],
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body = `${body}${chunk}`;
      const data = JSON.parse(body);
      requests.push(data);
      const prompt = JSON.parse(data.input[0].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    replacements: prompt.markedRevisions.map((a) => ({
                      id: a.id,
                      text: '**小明**負責，週五完成。',
                    })),
                  }),
                },
              ],
            },
          ],
        })
      );
    });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-annotations-')),
    env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    const page = await require('../setup/helpers.cjs').desktopWindow(app),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await require('../setup/helpers.cjs').overview(page);
    const notes =
      '# 會議紀錄\n\n**保留**開頭。\n\n待辦：**未指定**負責人。\n\n| 項目 | 狀態 |\n| --- | --- |\n| 測試 | 待確認 |\n\n保留結尾。';
    const id = await page.evaluate(
      async ({ notes, port }) => {
        const s = (await window.studio.invoke('bootstrap')).settings;
        s.llm.baseUrl = `http://127.0.0.1:${port}/v1`;
        await window.studio.invoke('settings:save', s);
        const p = await window.studio.invoke('project:create', 'Markdown 引用');
        const m = await window.studio.invoke('meeting:create', p.id, '引用修訂', 'file');
        await window.studio.invoke('meeting:update', m.id, { notes });
        return m.id;
      },
      { notes, port: server.address().port }
    );
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${id}"]`).first().click();

    const meeting = () => page.evaluate((id) => window.studio.invoke('meeting:get', id), id);

    const selectRaw = async (quote) => {
      await page.locator('#notes-editor').scrollIntoViewIfNeeded();
      await page.locator('#notes-editor').evaluate((e, quote) => {
        const start = e.value.indexOf(quote);
        e.focus();
        e.setSelectionRange(start, start + quote.length);
        e.dispatchEvent(new Event('select', { bubbles: true }));
      }, quote);
      await page.locator('.selection-toolbar').waitFor();
    };

    const addReply = async (text) => {
      const before = requests.length;
      await page.locator('#annotation-comment').waitFor();
      await page.locator('#annotation-comment').fill(text);
      await page.locator('#add-reply').click();
      await page.locator('#modal').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.id === 'agent-input');
      assert.equal(requests.length, before);
    };

    await page.locator('#agent-input').fill('原本的草稿');
    await selectRaw('待辦：**未指定**負責人。');
    assert.equal(await page.locator('.notes-pane .tabs [data-action="add-annotation"]').count(), 0);
    const toolbar = await page.locator('.selection-toolbar').boundingBox(),
      editor = await page.locator('#notes-editor').boundingBox();
    assert.ok(toolbar.y < editor.y + editor.height && toolbar.x >= 0);
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/selection-toolbar.png' });
    await page.locator('.selection-toolbar').click();
    await page.locator('#annotation-comment').waitFor();
    assert.equal(await page.locator('.reply-quote').count(), 0);
    assert.equal(await page.locator('#add-reply').isDisabled(), true);
    await page.locator('#annotation-comment').fill('   ');
    assert.equal(await page.locator('#add-reply').isDisabled(), true);
    await page.locator('#modal').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.locator('.reply-quote').count(), 0);
    await selectRaw('待辦：**未指定**負責人。');
    await page.locator('.selection-toolbar').click();
    await addReply('補上小明負責，週五完成。');
    await page.locator('.reply-quote').waitFor();
    assert.equal(
      await page.locator('.reply-quote blockquote').textContent(),
      '待辦：**未指定**負責人。'
    );
    assert.equal(await page.locator('#agent-input').inputValue(), '原本的草稿');
    assert.equal(await page.locator('.reply-comment').textContent(), '補上小明負責，週五完成。');
    assert.equal(requests.length, 0);
    assert.equal((await meeting()).annotations.length, 0);
    assert.equal(await page.locator('#modal[open]').count(), 0);
    await page.getByRole('button', { name: '移除引用', exact: true }).click();
    assert.equal(await page.locator('.reply-quote').count(), 0);
    await selectRaw('待辦：**未指定**負責人。');
    await page.keyboard.press('Control+Alt+m');
    await addReply('補上小明負責，週五完成。');
    await page.locator('.reply-quote').waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'agent-input');
    await page.locator('[data-editor-tab="preview"]').click();
    await page.locator('#notes-preview').evaluate((root) => {
      const span = [...root.querySelectorAll('strong [data-source-start]')].find(
        (s) => s.textContent === '保留'
      );
      const range = document.createRange();
      range.selectNodeContents(span);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.locator('.selection-toolbar').waitFor();
    await page.keyboard.press('Control+Alt+m');
    await addReply('保留這段原文');
    await page.waitForFunction(() => document.querySelectorAll('.reply-quote').length === 2);
    assert.equal(await page.locator('.reply-quote blockquote').last().textContent(), '保留');
    assert.equal(requests.length, 0);
    await page.getByRole('button', { name: '移除引用', exact: true }).last().click();
    await page.locator('#agent-input').fill('');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 950));
    await page.waitForFunction(() => !document.querySelector('.workspace-stacked'));
    await page.screenshot({ path: 'output/playwright/annotation-reply-card.png' });
    await page.locator('#agent-input').press('Enter');
    await page.locator('[data-action="review-proposal"]').waitFor();
    assert.equal(requests.length, 1);
    assert.equal(
      JSON.parse(requests[0].input[0].content).markedRevisions[0].comment,
      '補上小明負責，週五完成。'
    );
    assert.equal(
      JSON.parse(requests[0].input[0].content).markedRevisions[0].quote,
      '待辦：**未指定**負責人。'
    );
    assert.equal(await page.locator('.reply-quote').count(), 0);
    assert.equal((await meeting()).notes, notes);
    await page.locator('[data-annotation-edit]').click();
    await page.locator('#annotation-comment').fill('生成後的新指示');
    await page.locator('#save-annotation').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.locator('[data-action="review-proposal"]').click();
    assert.equal(await page.locator('#accept-proposal').isDisabled(), true);
    await page.locator('[data-close-modal]').click();
    await page.locator('[data-annotation-edit]').click();
    await page.locator('#annotation-comment').fill('補上小明負責，週五完成。');
    await page.locator('#save-annotation').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.locator('[data-action="review-proposal"]').click();
    await page.locator('#accept-proposal').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.locator('[data-editor-tab="edit"]').click();
    const expected = notes.replace('待辦：**未指定**負責人。', '**小明**負責，週五完成。');
    assert.equal(await page.locator('#notes-editor').inputValue(), expected);
    await selectRaw('保留結尾。');
    await page.keyboard.press('Control+Alt+m');
    await addReply('修改結尾');
    await page.locator('#notes-editor').fill(`新增前綴\n${expected}`);
    assert.equal(await page.locator('.reply-quote.stale').count(), 0);
    await page
      .locator('#notes-editor')
      .fill(`新增前綴\n${expected.replace('保留結尾。', '手動修改結尾。')}`);
    await page.locator('.reply-quote.stale').waitFor();
    await page.locator('#agent-input').fill('修改結尾');
    await page.locator('#agent-input').press('Enter');
    await page.getByText('引用原文已變動，請移除引用後重新選取', { exact: true }).waitFor();
    assert.equal(requests.length, 1);
    await page.getByRole('button', { name: '移除引用', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 700));
    await page.waitForFunction(
      () => innerWidth === 480 && !!document.querySelector('.workspace-stacked')
    );
    await selectRaw('手動修改結尾。');
    const compactToolbar = await page.locator('.selection-toolbar').boundingBox();
    assert.ok(compactToolbar.x >= 0 && compactToolbar.x + compactToolbar.width <= 480);
    await page.keyboard.press('Control+Alt+m');
    await addReply('重新回覆結尾');
    assert.equal(await page.locator('.reply-quote.stale').count(), 0);
    assert.equal(requests.length, 1);
    await page.locator('.reply-quote').scrollIntoViewIfNeeded();
    const compactCard = await page.locator('.reply-quote').boundingBox();
    assert.ok(compactCard.x >= 0 && compactCard.x + compactCard.width <= 480);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      document.querySelectorAll('#toasts button').forEach((button) => button.click());
    });
    await page.waitForFunction(() => document.querySelectorAll('#toasts button').length === 0);
    await page.screenshot({ path: 'output/playwright/annotation-reply-compact-dark.png' });
    await page.getByRole('button', { name: '移除引用', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await page.waitForFunction(() => innerWidth === 1280);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${id}"]`).first().click();
    assert.equal((await meeting()).annotations[0].status, 'resolved');
    assert.equal((await meeting()).annotations[0].quote, '待辦：**未指定**負責人。');
    assert.equal(
      await page.locator('.note-annotation blockquote').first().textContent(),
      '待辦：**未指定**負責人。'
    );
    assert.equal(await page.locator('.reply-quote').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Annotation reply UI passed: selection toolbar, keyboard shortcut, edit/preview source offsets, draft preservation/removal, no early inference, scoped explicit send, stale scope protection, rebase, apply and persistence.'
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
