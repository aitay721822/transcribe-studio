const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { Store, DEFAULTS } = require('../../../dist/persistence/store.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-context-ui-'));
  const requests = [];
  let hold = true;
  const sourceId = '6f7a8a6a-5d82-4fa4-9d50-502b836cf8c3';
  const missingId = 'b4845eff-9d4b-4c74-bc47-6028d290126c';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body = `${body}${chunk}`;
    const data = JSON.parse(body);
    requests.push(data);
    const prompt = JSON.parse(data.input[0].content);
    if (prompt.previousSummary != null && hold) return;
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
                  notes:
                    prompt.previousSummary != null
                      ? `使用者要求核對進度；nextOffset=1；來源[${sourceId}]`
                      : `# 新提案\n\n已確認週五交付。[${sourceId}]`,
                }),
              },
            ],
          },
        ],
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(path.join(profile, 'studio.sqlite'));
  const project = store.createProject('上下文與來源');
  const meeting = store.createMeeting(project.id, '產品交付會議', 'file');
  const notes =
    '# 會議紀錄\n\n週五交付。[' +
    sourceId +
    '][' +
    missingId +
    ']\n\n**待辦**：確認進度。\n\n| 項目 | 來源 |\n| --- | --- |\n| 交付 | [' +
    sourceId +
    '] |';
  store.updateMeeting(meeting.id, {
    notes,
    chats: [{ text: '核對來源與進度。'.repeat(100), createdAt: new Date().toISOString() }],
  });
  store.segment(meeting.id, {
    id: sourceId,
    text: '小明：我們確認在週五交付，請保留這段完整來源。',
    start: 62,
    end: 73,
    speaker: '小明',
    timing: 'provider',
    final: true,
  });
  store.saveRun({
    id: 'original',
    meetingId: meeting.id,
    status: 'failed',
    version: 1,
    startedAt: new Date().toISOString(),
    events: [
      { type: 'started' },
      { type: 'tool', name: 'studio_read_transcript', args: { offset: 0, limit: 1 } },
      {
        type: 'tool-result',
        name: 'studio_read_transcript',
        result: { segments: [{ id: sourceId, text: '保留完整 output 的來源' }], nextOffset: null },
      },
    ],
  });
  const settings = structuredClone(DEFAULTS);
  Object.assign(settings.llm, {
    model: 'fixture',
    apiKey: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    autoCompact: false,
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
    assert.equal(await page.locator('.workspace-pane > .pane-header').count(), 0);
    await page.waitForFunction(() => {
      const edit = document.querySelector('[data-editor-tab="edit"]').getBoundingClientRect();
      const save = document.querySelector('[data-action="save-notes"]').getBoundingClientRect();
      return Math.abs(edit.y - save.y) < 10;
    });
    const { edit, save } = await page.evaluate(() => ({
      edit: document.querySelector('[data-editor-tab="edit"]').getBoundingClientRect().toJSON(),
      save: document.querySelector('[data-action="save-notes"]').getBoundingClientRect().toJSON(),
    }));
    assert.ok(Math.abs(edit.y - save.y) < 10);
    assert.ok(save.x > edit.x + edit.width);
    await page.locator('[data-editor-tab="preview"]').click();
    assert.equal(await page.locator('#notes-preview [data-citation]').count(), 3);
    await page.locator('#notes-preview [data-citation]').first().click();
    await page.locator('.source-popover').waitFor();
    assert.match(await page.locator('.source-popover').textContent(), /00:01:02–00:01:13/);
    assert.match(await page.locator('.source-popover').textContent(), /請保留這段完整來源/);
    await page.keyboard.press('Escape');
    await page.locator(`[data-citation="${missingId}"]`).click();
    assert.match(await page.locator('.source-popover').textContent(), /目前會議找不到此片段/);
    await page.keyboard.press('Escape');
    await page.locator('#notes-preview').evaluate((root) => {
      const paragraph = root.querySelector('p:has(.source-citation)');
      const first = paragraph.querySelector('[data-source-start]').firstChild;
      const last = paragraph.querySelectorAll('.source-citation')[1].firstChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.locator('[data-action="add-annotation"]').click();
    await page.locator('#annotation-comment').fill('核對這段來源');
    await page.locator('#add-reply').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(
      await page.locator('.reply-quote blockquote').textContent(),
      `週五交付。[${sourceId}][${missingId}]`
    );
    await page.getByRole('button', { name: '移除引用', exact: true }).click();
    await page.locator('#agent-input').fill('/');
    assert.equal(await page.locator('.slash-menu [role="option"]').count(), 3);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#agent-input').inputValue(), '/compact');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('.compaction-card.running').waitFor();
    const blocked = await page.evaluate(async (id) => {
      try {
        await window.studio.invoke('agent:command', id, 'clear');
        return '';
      } catch (e) {
        return e.message;
      }
    }, meeting.id);
    assert.match(blocked, /請先停止/);
    await page.locator('[data-action="cancel-agent"]').click();
    await page.getByText('Agent 已停止', { exact: true }).waitFor();
    const uncommitted = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      meeting.id
    );
    assert.equal(uncommitted.contextMemory, undefined);
    hold = false;
    await page.locator('#agent-input').fill('/compact');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('.compaction-card.completed').waitFor();
    await page.locator('[data-action="run-agent"]').waitFor();
    const compacted = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      meeting.id
    );
    assert.match(compacted.contextMemory.summary, /nextOffset=1/);
    assert.equal(compacted.chats.length, 1);
    await page.locator('#agent-input').fill('繼續核對');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('[data-action="review-proposal"]').waitFor();
    assert.match(JSON.parse(requests.at(-1).input[0].content).contextSummary, /nextOffset=1/);
    await page.locator('[data-action="review-proposal"]').click();
    await page.locator('#modal [data-citation]').last().click();
    assert.match(await page.locator('.source-popover').textContent(), /週五交付/);
    assert.equal(
      await page.locator('#modal .source-popover').count(),
      1,
      'source popup stays inside the modal top layer'
    );
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelector('#modal').close());
    await page.locator('#agent-input').fill('/clear');
    await page.locator('[data-action="run-agent"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-user').length === 0);
    const cleared = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      meeting.id
    );
    assert.equal(cleared.notes, notes);
    assert.equal(cleared.segments.length, 1);
    assert.equal(cleared.contextMemory, undefined);
    const raw = await fs.readFile(
      path.join(profile, 'conversations', `${meeting.id}.jsonl`),
      'utf8'
    );
    assert.match(raw, /保留完整 output 的來源/);
    assert.match(raw, /conversation-reset/);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    assert.equal(await page.locator('.chat-user').count(), 0);
    assert.equal(await page.locator('.agent-tool-trace').count(), 0);
    await page.locator('[data-editor-tab="preview"]').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 950));
    await page.waitForFunction(() => !document.querySelector('.workspace-stacked'));
    await fs.mkdir('output/playwright', { recursive: true });
    await page.locator('#notes-preview [data-citation]').first().click();
    await page.screenshot({ path: 'output/playwright/context-and-citations.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 700));
    await page.waitForFunction(() => innerWidth === 480);
    await page.waitForFunction(() => {
      const box = document.querySelector('.source-popover').getBoundingClientRect();
      return box.x >= 0 && box.right <= innerWidth;
    });
    const bubble = await page.locator('.source-popover').boundingBox();
    assert.ok(bubble.x >= 0 && bubble.x + bubble.width <= 480);
    assert.deepEqual(errors, []);
    console.log(
      'Context UI passed: removed headers, save placement, source bubbles and proposals, slash menu, compaction, cancellation, budget state, clear, raw history, reload and narrow popover.'
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
