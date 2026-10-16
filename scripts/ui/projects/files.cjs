const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { Store, DEFAULTS } = require('../../../dist/persistence/store.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-files-ui-'));
  const directory = path.join(profile, 'references');
  await fs.mkdir(directory);
  for (let i = 0; i < 650; i += 50)
    await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        fs.writeFile(path.join(directory, `file-${i + n}.txt`), '普通參考資料')
      )
    );
  await fs.writeFile(path.join(directory, 'reader.txt'), `${'界🙂\n'.repeat(6000)}END-READER`);
  await fs.writeFile(
    path.join(directory, 'late.log'),
    `${'ordinary data\n'.repeat(700000)}UNIQUE-END：小明週五交付。\n`
  );
  let step = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body = `${body}${chunk}`;
    const data = JSON.parse(body);
    requests.push(data);
    let output;
    if (++step === 1)
      output = [
        {
          type: 'function_call',
          call_id: 'search',
          name: 'studio_search_files',
          arguments: JSON.stringify({ query: 'UNIQUE-END', rootId: 'root', directory: '' }),
        },
      ];
    else {
      const result = JSON.parse(
        data.input.filter((x) => x.type === 'function_call_output').at(-1).output
      );
      if (step === 2) {
        assert.ok(result.stats.visited > 500);
        const hit = result.matches[0];
        assert.ok(hit.offset > 8000000);
        output = [
          {
            type: 'function_call',
            call_id: 'read',
            name: 'studio_read_file',
            arguments: JSON.stringify({
              rootId: hit.rootId,
              relative: hit.relative,
              offset: hit.offset,
              version: hit.version,
              limit: 16,
            }),
          },
        ];
      } else if (step === 3) {
        assert.notEqual(result.nextOffset, null);
        output = [
          {
            type: 'function_call',
            call_id: 'tail',
            name: 'studio_read_file',
            arguments: JSON.stringify({
              rootId: result.rootId,
              relative: result.relative,
              offset: result.nextOffset,
              version: result.version,
              limit: 16000,
            }),
          },
        ];
      } else {
        assert.match(result.text, /週五交付/);
        assert.equal(result.nextOffset, null);
        output = [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '# 決議\n小明週五交付。[參考/late.log]' }],
          },
        ];
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(path.join(profile, 'studio.sqlite'));
  const project = store.createProject('大型參考資料');
  store.updateProject(project.id, {
    roots: [{ id: 'root', path: directory, name: '參考', mode: 'readonly' }],
  });
  const meeting = store.createMeeting(project.id, '檔案工具測試', 'file');
  const settings = structuredClone(DEFAULTS);
  Object.assign(settings.llm, {
    model: 'fixture',
    apiKey: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  });
  settings.asr.fileApiKey = 'fixture';
  store.saveSettings(settings);
  store.close();
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
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
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    assert.equal(await page.locator('[data-source-tab="files"]').count(), 0);
    const input = page.locator('#agent-input');
    assert.equal(await page.locator('.agent-input-wrap #skill-select-trigger').count(), 1);
    assert.equal(await page.locator('.agent-input-wrap #agent-send-actions').count(), 1);
    const card = await page.locator('.agent-input-wrap').boundingBox();
    const send = await page.locator('#agent-send-actions').boundingBox();
    const add = await page.locator('.composer-add').boundingBox();
    assert.ok(send.y >= card.y && send.y + send.height <= card.y + card.height);
    assert.ok(Math.abs(send.y - add.y) < 5, 'plus and submit share the bottom toolbar');
    assert.match(await page.locator('.composer-model').textContent(), /fixture/);
    await input.fill('保留訊息');
    await page.getByRole('button', { name: '新增檔案或資料夾', exact: true }).click();
    await page.locator('.mention-menu').waitFor();
    assert.equal(await input.inputValue(), '保留訊息 @');
    await page.getByRole('button', { name: '檔案和資料夾 指定來源路徑', exact: true }).click();
    await page.getByRole('textbox', { name: '直接指定相對路徑' }).waitFor();
    assert.equal(
      await page
        .getByRole('textbox', { name: '直接指定相對路徑' })
        .evaluate((el) => el === document.activeElement),
      true
    );
    await input.focus();
    await input.press('Escape');
    await page.locator('.mention-menu').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '新增檔案或資料夾', exact: true }).click();
    await page.locator('.mention-skills button').first().click();
    assert.notEqual(await page.locator('#skill-select').inputValue(), '');
    assert.match(await input.inputValue(), /^保留訊息 /);
    assert.equal((await input.inputValue()).includes('@'), false);
    assert.equal(requests.length, 0);
    await input.fill('@file-');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-reference-kind="file"]').length === 20
    );
    await input.scrollIntoViewIfNeeded();
    await page.locator('.mention-menu').screenshot({ path: 'output/playwright/mention-menu.png' });
    const first = await page
      .locator('[data-reference-kind="file"]')
      .first()
      .getAttribute('data-reference-path');
    assert.equal(await page.locator('#agent-reference-list [role="option"]').count(), 21);
    await page.getByRole('button', { name: '繼續搜尋／下一批', exact: true }).click();
    await page.waitForFunction(
      (name) =>
        document.querySelector('[data-reference-kind="file"]')?.dataset.referencePath !== name,
      first
    );
    assert.ok((await page.locator('[data-reference-kind="file"]').count()) <= 20);
    await input.press('Escape');
    await page.locator('.mention-menu').waitFor({ state: 'hidden' });
    await input.fill('@file-');
    await input.fill('@not-current');
    await input.fill('@reader.txt');
    await page.locator('[data-reference-kind="file"][data-reference-path="reader.txt"]').waitFor();
    await input.press('Enter');
    await page.locator('.reference-chip').filter({ hasText: 'reader.txt' }).waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(requests.length, 0, 'Enter selects a reference without sending');
    await input.fill('@reader.txt');
    await page.locator('[data-reference-kind="file"][data-reference-path="reader.txt"]').waitFor();
    await input.press('Tab');
    await page.locator('.mention-menu').waitFor({ state: 'hidden' });
    assert.equal(
      await page.locator('.reference-chip').count(),
      1,
      'duplicate source is deduplicated'
    );
    await input.fill('@');
    await page.locator('[data-reference-kind="directory"][data-reference-path=""]').waitFor();
    await input.press('Enter');
    await page.locator('.reference-chip').filter({ hasText: '資料夾' }).waitFor();
    await input.fill('@known-path');
    await page.locator('.mention-direct summary').click();
    await page.getByRole('combobox', { name: /^路徑所屬資料夾/ }).click();
    await page.locator('.dropdown-popup').getByRole('option').first().click();
    assert.equal(
      await page.getByRole('textbox', { name: '直接指定相對路徑' }).getAttribute('data-slot'),
      'input'
    );
    await page.getByRole('textbox', { name: '直接指定相對路徑' }).fill('../outside.txt');
    await page.getByRole('button', { name: '加入指定路徑', exact: true }).click();
    await page.locator('.mention-menu [role="alert"]').filter({ hasText: '超出' }).waitFor();
    await page.getByRole('textbox', { name: '直接指定相對路徑' }).fill('reader.txt');
    await page.getByRole('button', { name: '加入指定路徑', exact: true }).click();
    await page.locator('.mention-menu').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.reference-chip').count(), 2);
    await input.fill('@UNIQUE-END');
    await page.locator('[data-reference-kind="search"]').click();
    await page.locator('.reference-chip').filter({ hasText: '搜尋：UNIQUE-END' }).waitFor();
    assert.equal(requests.length, 0);
    await fs.mkdir('output/playwright', { recursive: true });
    await input.scrollIntoViewIfNeeded();
    await page
      .locator('.agent-input-wrap')
      .screenshot({ path: 'output/playwright/mention-reference-chips.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 700));
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await input.fill('@reader.txt');
    await page.locator('[data-reference-kind="file"][data-reference-path="reader.txt"]').waitFor();
    await page.locator('.mention-menu').scrollIntoViewIfNeeded();
    const menuBox = await page.locator('.mention-menu').boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 600);
    await page
      .locator('.mention-menu')
      .screenshot({ path: 'output/playwright/mention-menu-dark-narrow.png' });
    await page.locator('#agent-send-actions').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const menu = document.querySelector('.mention-menu').getBoundingClientRect();
      const card = document.querySelector('.agent-input-wrap').getBoundingClientRect();
      return Math.abs(menu.bottom + 8 - card.top) < 2 || Math.abs(menu.top - 8 - card.bottom) < 2;
    });
    await page.screenshot({ path: 'output/playwright/agent-composer-reference-layout.png' });
    await input.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Control+p');
    await page.locator('#file-search').fill('reader.txt');
    await page.locator('#project-files button').first().click();
    await page.locator('#project-file-preview').waitFor();
    const before = await page.locator('#project-file-preview').textContent();
    assert.ok(!before.includes('�'));
    await page.getByRole('button', { name: '下一段', exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector('[aria-label="分段檔案預覽"]').textContent.includes('offset 0 ·')
    );
    assert.ok(!(await page.locator('#project-file-preview').textContent()).includes('�'));
    await page.getByRole('button', { name: '上一段', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="分段檔案預覽"]').textContent.includes('offset 0 ·')
    );
    assert.equal(await page.locator('#project-file-preview').textContent(), before);
    await page.keyboard.press('Escape');
    await page.locator('#agent-input').fill('搜尋 UNIQUE-END 並讀取完整來源');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('[data-action="review-proposal"]').waitFor();
    assert.equal(requests.length, 4);
    const prompt = JSON.parse(requests[0].input.filter((x) => x.role === 'user').at(-1).content);
    assert.equal(prompt.references.length, 3);
    assert.ok(prompt.references.some((r) => r.kind === 'search' && r.query === 'UNIQUE-END'));
    assert.ok(prompt.references.some((r) => r.kind === 'directory' && r.rootId === 'root'));
    assert.equal(await page.locator('.agent-input-wrap .reference-chip').count(), 0);
    assert.equal(await page.locator('.chat-user .reference-chip').count(), 3);
    const persisted = await page.evaluate(
      (id) => window.studio.invoke('agent:trace', id),
      meeting.id
    );
    assert.equal(persisted.events.find((e) => e.type === 'request').args.references.length, 3);
    const search = page.locator('.agent-tool-trace[data-tool="studio_search_files"]');
    assert.match(await search.locator('summary').textContent(), /掃描完成/);
    await search.locator('summary').click();
    assert.match(
      await search.locator('pre[aria-label="output（完整回傳）"]').textContent(),
      /UNIQUE-END/
    );
    const read = page.locator('.agent-tool-trace[data-tool="studio_read_file"]').last();
    await read.locator('summary').click();
    assert.match(
      await read.locator('pre[aria-label="output（完整回傳）"]').textContent(),
      /週五交付/
    );
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/large-file-search.png' });
    assert.deepEqual(errors, []);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    await page.locator('.chat-user .sent-references').waitFor();
    assert.equal(
      await page.locator('.chat-user .reference-chip').count(),
      3,
      'sent references survive reload'
    );
    console.log(
      'File mentions UI passed: bounded batches, next/cancel/change query, keyboard selection without send, dedupe, direct paths/escape guard, folder/search chips, UTF preview pages, actual late-file search/read tools, per-message reference trace.'
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
