const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { Store, DEFAULTS } = require('../../../dist/persistence/store.cjs');

const until = async (check) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition timed out');
};

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-session-ui-'));
  const requests = [],
    gates = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body = `${body}${chunk}`;
    const data = JSON.parse(body);
    requests.push(data);
    const first = data.input[0].content;
    const prompt = JSON.parse(
      typeof first === 'string' ? first : first.find((part) => part.type === 'input_text').text
    );
    if (prompt.request.includes('BLOCK') && data.input.length === 1)
      await new Promise((resolve) => gates.push(resolve));
    if (res.destroyed) return;

    const replyText = () => {
      if (prompt.markedRevisions?.length) {
        return JSON.stringify({
          replacements: prompt.markedRevisions.map((mark) => ({
            id: mark.id,
            text: '# 已套用暫時修訂',
          })),
        });
      }
      if (prompt.mode === 'read') {
        return JSON.stringify({ answer: `唯讀回答：${prompt.request}` });
      }
      return '# 修改提案\n已核對資料。';
    };

    const text = replyText();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      })
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const store = new Store(path.join(profile, 'studio.sqlite'));
  const project = store.createProject('權限與暫時對話');
  const meeting = store.createMeeting(project.id, '對話測試');
  store.updateMeeting(meeting.id, { notes: '# 原稿' });
  const settings = structuredClone(DEFAULTS);
  Object.assign(settings.llm, {
    model: 'vision-fixture',
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
    page.on('pageerror', (error) => errors.push(error.message));
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    const input = page.locator('#agent-input');

    const permissions = () => page.locator('.composer-permissions').click();

    const setMode = async (name) => {
      await permissions();
      await page.locator('.permission-option').filter({ hasText: name }).click();
      await page.keyboard.press('Escape');
    };

    const addImages = async (names) => {
      const buffer = await fs.readFile('config/branding/native/icon.png');
      await page
        .locator('#agent-image-picker')
        .setInputFiles(names.map((name) => ({ name, mimeType: 'image/png', buffer })));
      await until(async () => (await page.locator('.image-attachment').count()) === names.length);
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('.image-attachment img')).every(
          (img) => img.complete && img.naturalWidth > 0
        )
      );
    };

    await setMode('唯讀模式');
    await addImages(['first.png', 'second.png']);
    await input.fill('核對圖片，不修改紀錄');
    await input.press('Enter');
    await page.locator('.chat-assistant').filter({ hasText: '核對圖片' }).waitFor();
    assert.equal(await page.locator('[data-action="review-proposal"]').count(), 0);
    assert.equal(await page.locator('#notes-editor').inputValue(), '# 原稿');
    assert.equal(
      requests[0].input[0].content.filter((part) => part.type === 'input_image').length,
      2
    );
    assert.equal(await page.locator('.image-attachment').count(), 0);
    assert.equal(await page.locator('.chat-user .chat-images img').count(), 2);
    await permissions();
    await page.getByRole('checkbox', { name: '暫時對話', exact: true }).check();
    await page.locator('.agent-input-wrap.is-temporary').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.chat-user').count(), 0);
    await addImages(['temporary.png']);
    const temporaryImage = await page.locator('.image-attachment img').getAttribute('src');
    await input.fill('TEMP-PRIVATE');
    await input.press('Enter');
    await page.locator('.chat-assistant').filter({ hasText: 'TEMP-PRIVATE' }).waitFor();
    const persistent = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      meeting.id
    );
    assert.equal(persistent.chats.length, 1);
    assert.equal(persistent.chats[0].text.includes('TEMP-'), false);
    await input.fill('TEMP-BLOCK');
    await input.press('Enter');
    await page.locator('[data-action="cancel-agent"]').waitFor();
    await until(() => gates.length > 0);
    await permissions();
    const temporaryCheckbox = page.getByRole('checkbox', { name: '暫時對話', exact: true });
    assert.equal(await temporaryCheckbox.isDisabled(), true);
    assert.equal(await temporaryCheckbox.isChecked(), true);
    assert.equal(
      await temporaryCheckbox.evaluate((element) => getComputedStyle(element).opacity),
      '0.5'
    );
    await page.keyboard.press('Escape');
    await page.locator(`[data-project="${project.id}"]`).first().click();
    await page.locator('.agent-input-wrap.is-temporary').waitFor({ state: 'hidden' });
    gates.splice(0).forEach((release) => release());
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    await input.waitFor();
    assert.equal((await page.locator('#agent-feed').textContent()).includes('TEMP-PRIVATE'), false);
    await until(async () => {
      const root = path.join(profile, 'runtime', 'temporary');
      return (await fs.readdir(root).catch(() => [])).length === 0;
    });
    const journal = await fs.readFile(
      path.join(profile, 'conversations', `${meeting.id}.jsonl`),
      'utf8'
    );
    assert.equal(journal.includes('TEMP-PRIVATE'), false);
    assert.equal(journal.includes('TEMP-BLOCK'), false);
    assert.equal(journal.includes('data:image/png;base64'), false);
    assert.equal(
      await page.evaluate(async (url) => {
        const img = new Image();
        return await new Promise((r) => {
          img.onload = () => r(true);
          img.onerror = () => r(false);
          img.src = url;
        });
      }, `${temporaryImage}?probe=${Date.now()}`),
      false
    );
    await setMode('編修模式');
    await input.fill('BLOCK-EDIT');
    await input.press('Enter');
    await page.locator('[data-action="cancel-agent"]').waitFor();
    await until(() => gates.length > 0);
    await addImages(['queued-first.png', 'queued-second.png']);
    await input.fill('QUEUE-PICTURES');
    await input.press('Control+Enter');
    const queued = page.locator('.agent-queue-item');
    await queued.waitFor();
    assert.equal(await queued.getAttribute('open'), null);
    assert.equal(await queued.locator('summary img').count(), 1);
    assert.equal(await queued.locator('summary .queue-thumbnail > span').textContent(), '2');
    assert.equal(await page.locator('.chat-user').filter({ hasText: 'QUEUE-PICTURES' }).count(), 0);
    await queued.locator('summary').click();
    assert.equal(await queued.locator('.queue-detail img').count(), 2);
    await queued.locator('summary').click();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await page
      .locator('.agent-composer')
      .screenshot({ path: 'output/playwright/image-queue-composer.png' });
    await queued.locator('[data-steer-input]').click();
    await queued.waitFor({ state: 'hidden' });
    gates.splice(0).forEach((release) => release());
    await page.locator('[data-action="review-proposal"]').waitFor();
    const last = requests
      .at(-1)
      .input.filter((item) => item.role === 'user')
      .at(-1).content;
    assert.equal(
      last.filter((part) => part.type === 'input_image').length,
      2,
      'queued images reach steering request'
    );
    assert.match(last.find((part) => part.type === 'input_text').text, /QUEUE-PICTURES/);
    await permissions();
    await page
      .locator('.permission-menu')
      .screenshot({ path: 'output/playwright/agent-permission-menu.png' });
    await page.keyboard.press('Escape');
    await permissions();
    await page.getByRole('checkbox', { name: '暫時對話', exact: true }).check();
    await page.locator('.agent-input-wrap.is-temporary').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#notes-editor').evaluate((editor) => {
      editor.focus();
      editor.setSelectionRange(0, editor.value.length);
      editor.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await page.keyboard.press('Control+Alt+m');
    await page.getByRole('textbox', { name: '回覆內容', exact: true }).fill('TEMP-COMMENT');
    await page.locator('#add-reply').click();
    await input.fill('TEMP-APPLY');
    await input.press('Enter');
    await page.locator('[data-action="review-proposal"]').waitFor();
    await page.locator('[data-action="review-proposal"]').click();
    await page.locator('#accept-proposal').click();
    await page.waitForFunction(() =>
      document.querySelector('#notes-editor').value.includes('已套用暫時修訂')
    );
    const applied = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      meeting.id
    );
    assert.match(applied.notes, /已套用暫時修訂/);
    assert.equal(JSON.stringify(applied.annotations || []).includes('TEMP-COMMENT'), false);
    assert.equal(JSON.stringify(applied.chats).includes('TEMP-APPLY'), false);
    await page.locator(`[data-project="${project.id}"]`).first().click();
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    await input.waitFor();
    assert.match(await page.locator('#notes-editor').inputValue(), /已套用暫時修訂/);
    assert.deepEqual(errors, []);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    await page.locator('.chat-user .chat-images img').first().waitFor();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.chat-user .chat-images img')).every(
        (img) => img.complete && img.naturalWidth > 0
      )
    );
    assert.equal((await page.locator('#agent-feed').textContent()).includes('TEMP-PRIVATE'), false);
    console.log(
      'Conversation UI passed: enforced read-only answers, image upload/preview/payload/history, memory-only temporary conversations and cleanup during inference, explicit scoped apply without saving private comments, collapsed image queue, first thumbnail/count, expand/remove/steer with all images.'
    );
  } finally {
    gates.splice(0).forEach((release) => release());
    await app.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
