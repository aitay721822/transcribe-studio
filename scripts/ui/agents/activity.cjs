const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Store, DEFAULTS } = require('../../../dist/persistence/store.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-agent-activity-'));
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain the request */
    }
    if (++requests > 1) return;
    const specs = [
      ['studio_read_notes', {}],
      ['studio_read_transcript', { offset: 0, limit: 2 }],
      ['studio_read_transcript', { offset: 2, limit: 2 }],
      ['studio_read_transcript', { offset: 0, limit: 2 }],
      ['studio_read_transcript', { limit: 1000 }],
    ];
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: specs.map(([name, args], index) => ({
          type: 'function_call',
          call_id: `call-${index}`,
          name,
          arguments: JSON.stringify(args),
        })),
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(path.join(profile, 'studio.sqlite'));
  const project = store.createProject('Agent 詳細紀錄');
  const meeting = store.createMeeting(project.id, '長會議逐字稿', 'file');
  for (let i = 0; i < 3; i++)
    store.segment(meeting.id, {
      id: `segment-${i}`,
      text: `${'完整逐字稿內容。'.repeat(600)}END-${i}`,
      start: i * 30,
      end: i * 30 + 30,
      final: true,
    });
  const settings = structuredClone(DEFAULTS);
  settings.asr.fileUrl = 'http://127.0.0.1:1/audio/transcriptions';
  Object.assign(settings.llm, {
    apiKey: 'local-test',
    model: 'local-test',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  });
  store.saveSettings(settings);
  store.saveRun({
    id: 'legacy-run',
    meetingId: meeting.id,
    startedAt: new Date().toISOString(),
    status: 'failed',
    version: 0,
    events: [
      { type: 'started' },
      { type: 'tool', name: 'studio_read_transcript', args: { offset: 99, limit: 1 } },
      {
        type: 'tool-result',
        name: 'studio_read_transcript',
        result: {
          total: 100,
          nextOffset: null,
          segments: [{ id: 'legacy', text: '舊版完整 output' }],
        },
      },
    ],
  });
  store.close();
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    const page = await require('../setup/helpers.cjs').desktopWindow(app);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    await page.locator('.agent-tool-trace summary').click();
    assert.match(
      await page.locator('pre[aria-label="output（完整回傳）"]').textContent(),
      /舊版完整 output/
    );
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    await page.locator('#llm-steps').fill('240');
    await page.locator('#llm-tools').fill('350');
    await page.locator('#llm-timeout').fill('12');
    await page.locator('[data-action="save-settings"]').click();
    await page.getByText('設定已儲存', { exact: true }).waitFor();
    const saved = (await page.evaluate(() => window.studio.invoke('bootstrap'))).settings.llm;
    assert.deepEqual([saved.maxSteps, saved.maxToolCalls, saved.timeoutMinutes], [240, 350, 12]);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    assert.equal(await page.locator('#llm-timeout').inputValue(), '12');
    assert.equal(await page.locator('#llm-tools').inputValue(), '350');
    await assert.rejects(
      page.evaluate(async () => {
        const s = (await window.studio.invoke('bootstrap')).settings;
        s.llm.timeoutMinutes = -1;
        await window.studio.invoke('settings:save', s);
      }),
      /整數/
    );
    // Set both unlimited options through the UI and retain them as numeric zero.
    await page.locator('#llm-tools').fill('0');
    await page.locator('#llm-timeout').fill('0');
    await page.locator('[data-action="save-settings"]').click();
    const unlimited = (await page.evaluate(() => window.studio.invoke('bootstrap'))).settings.llm;
    assert.equal(unlimited.maxToolCalls, 0);
    assert.equal(unlimited.timeoutMinutes, 0);
    await page.locator('#llm-tools').fill('350');
    await page.locator('#llm-timeout').fill('12');
    await page.locator('[data-action="save-settings"]').click();
    await page.evaluate((id) => window.studio.invoke('meeting:get', id), meeting.id);
    await page.locator('[data-action="back-workspace"]').click();
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    await page.locator('#agent-input').fill('請整理完整會議紀錄');
    await page.locator('[data-action="run-agent"]').click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.agent-tool-trace').length === 5 &&
        document.querySelectorAll('.agent-tool-trace[data-status="失敗"]').length === 1
    );
    assert.equal(await page.locator('.agent-tool-body').count(), 0, 'raw JSON is rendered lazily');
    assert.match(await page.locator('.agent-execution').textContent(), /12 分鐘/);
    assert.match(await page.locator('.agent-execution').textContent(), /3 \/ 3 個逐字稿/);
    assert.equal(await page.getByText('同一組參數已呼叫 2 次', { exact: true }).count(), 1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await page.waitForFunction(() => innerWidth === 1600);
    const first = page.locator('.agent-tool-trace[data-tool="studio_read_transcript"]').first();
    await first.locator('summary').click();
    const input = JSON.parse(await first.locator('pre[aria-label="傳入參數"]').textContent());
    const output = JSON.parse(
      await first.locator('pre[aria-label="output（完整回傳）"]').textContent()
    );
    assert.deepEqual(input, { offset: 0, limit: 2 });
    assert(output.segments[1].text.endsWith('END-1'));
    assert.equal(output.nextOffset, 2);
    const nativeClipboard = await app.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('studio-native-clipboard-probe');
      const available = (await clipboard.readText()) === 'studio-native-clipboard-probe';
      const write = clipboard.writeText.bind(clipboard);
      clipboard.writeText = async (text) => {
        await write(text);
        globalThis.studioCopiedTrace = text;
      };
      return available;
    });
    await first
      .locator('.agent-json-detail')
      .nth(1)
      .getByRole('button', { name: '複製完整內容' })
      .click();
    await first
      .locator('.agent-json-detail')
      .nth(1)
      .getByRole('button', { name: '已複製' })
      .waitFor();
    assert.deepEqual(JSON.parse(await app.evaluate(() => globalThis.studioCopiedTrace)), output);
    if (nativeClipboard)
      assert.deepEqual(
        JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText())),
        output
      );
    else
      console.log(
        'Native clipboard roundtrip unavailable on this host; verified the exact payload delivered to the real clipboard API.'
      );
    await page.locator('#notes-editor').fill('進度更新時保留的草稿');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await page.locator('#notes-editor').inputValue(), '進度更新時保留的草稿');
    assert.equal(await first.getAttribute('open'), '', 'details stay expanded during updates');
    await page.evaluate(async () => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      Object.assign(s.llm, { timeoutMinutes: 1, maxToolCalls: 1 });
      await window.studio.invoke('settings:save', s);
    });
    assert.match(await page.locator('.agent-execution').textContent(), /12 分鐘/);
    await fs.mkdir('output/playwright', { recursive: true });
    await page.evaluate(() =>
      document.querySelectorAll('#toasts button').forEach((button) => button.click())
    );
    await first.locator('summary').scrollIntoViewIfNeeded();
    await page
      .locator('.agent-pane')
      .screenshot({ path: 'output/playwright/agent-tool-details.png' });
    await page.locator('[data-action="cancel-agent"]').click();
    await page.getByText('Agent 已停止', { exact: true }).waitFor();
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-meeting="${meeting.id}"]`).first().click();
    await page.locator('.agent-tool-trace').nth(4).waitFor();
    assert.equal(
      await page.locator('.agent-tool-trace').count(),
      5,
      'full trace returns after reload'
    );
    await page
      .locator('.agent-tool-trace[data-tool="studio_read_transcript"]')
      .first()
      .locator('summary')
      .click();
    assert.match(await page.locator('pre[aria-label="output（完整回傳）"]').textContent(), /END-1/);
    await require('../setup/helpers.cjs').resizeWindow(app, page, 480, 700);
    assert(
      await page.evaluate(() =>
        [...document.querySelectorAll('.agent-tool-trace')].every(
          (element) => element.scrollWidth <= element.clientWidth
        )
      )
    );
    assert.deepEqual(errors, []);
    console.log(
      'Agent activity UI passed: persisted independent/unlimited limits, legacy and live complete traces, paging/repeat summaries, copy, elapsed progress, stable drafts, cancellation and reload.'
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
