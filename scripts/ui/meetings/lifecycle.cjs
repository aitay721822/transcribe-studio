const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-meeting-ui-'));
  let previousId;
  let calls = 0;
  let lastInput;
  let heldResponse;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body = `${body}${chunk}`;
    lastInput = JSON.parse(body).input;
    calls++;
    if (calls > 3) {
      heldResponse = res;
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output:
          calls < 3
            ? [
                {
                  type: 'function_call',
                  call_id: `history-${calls}`,
                  name: calls === 1 ? 'studio_search_meetings' : 'studio_read_meeting',
                  arguments: JSON.stringify(
                    calls === 1 ? { query: '既有方案' } : { meetingId: previousId }
                  ),
                },
              ]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text:
                        '# 本次會議\n\n歷史背景：既有方案採用串流辨識 [會議:' +
                        previousId +
                        ':v1]\n\n本次決議：待確認',
                    },
                  ],
                },
              ],
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    const fixture = await page.evaluate(async (port) => {
      const p = await window.studio.invoke('project:create', '專案');
      const previous = await window.studio.invoke('meeting:create', p.id, '先前會議', 'file');
      await window.studio.invoke(
        'meeting:update',
        previous.id,
        { notes: '既有方案採用串流辨識', status: 'completed' },
        previous.version
      );
      const current = await window.studio.invoke('meeting:create', p.id, '本次會議', 'live');
      const remove = await window.studio.invoke('meeting:create', p.id, '可刪除會議', 'file');
      const recording = await window.studio.invoke('audio:start', remove.id);
      await window.studio.invoke('audio:chunk', recording, [1, 2, 3]);
      await window.studio.invoke('audio:finish', recording, 1);
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.theme = 'dark';
      s.llm = {
        ...s.llm,
        backend: 'openai',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'local-test',
        apiKey: 'local-key',
        maxSteps: 4,
      };
      await window.studio.invoke('settings:save', s);
      return {
        projectId: p.id,
        previousId: previous.id,
        currentId: current.id,
        removeId: remove.id,
        recording,
      };
    }, server.address().port);
    previousId = fixture.previousId;
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator('[data-action="go-meetings"]').click();
    const alignment = await page
      .locator('.meeting-row-actions')
      .first()
      .evaluate((actions) => {
        const icons = [...actions.querySelectorAll('svg')].map((icon) =>
          icon.getBoundingClientRect()
        );
        const row = actions.closest('tr').getBoundingClientRect();
        return icons.map((icon) => Math.abs(icon.y + icon.height / 2 - row.y - row.height / 2));
      });
    assert(
      alignment.length === 2 && alignment.every((offset) => offset < 1),
      'row icons are vertically centered'
    );
    await fs.mkdir('output/playwright', { recursive: true });
    await page
      .locator('.table-wrap')
      .screenshot({ path: 'output/playwright/meeting-row-alignment.png' });
    const removeButton = page.locator(`.meeting-row [data-delete-meeting="${fixture.removeId}"]`);
    await removeButton.click();
    await page.getByRole('heading', { name: '刪除會議', exact: true }).waitFor();
    await page.locator('#cancel-delete-meeting').click();
    assert.equal(await page.locator(`.meeting-row[data-meeting="${fixture.removeId}"]`).count(), 1);
    assert.equal(await page.locator('#notes-editor').count(), 0);
    await removeButton.click();
    await page.locator('#confirm-delete-meeting').click();
    await page.waitForFunction(
      (id) => !document.querySelector(`.meeting-row[data-meeting="${id}"]`),
      fixture.removeId
    );
    assert.equal((await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings.length, 2);
    await assert.rejects(fs.access(path.join(profile, 'audio', `${fixture.recording}.webm`)));
    await page.locator(`.meeting-row[data-meeting="${fixture.currentId}"]`).click();
    await page.locator('#agent-input').fill('請參考先前會議紀錄整理本次紀錄');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('[data-action="review-proposal"]').waitFor();
    assert(
      lastInput.some(
        (item) =>
          item.type === 'function_call_output' && item.output.includes('既有方案採用串流辨識')
      )
    );
    await page.locator('[data-action="review-proposal"]').click();
    await page.locator('#accept-proposal').click();
    await page.waitForFunction(
      (id) => document.querySelector('#notes-editor').value.includes(id),
      previousId
    );
    await page.locator('#agent-input').fill('再次修訂');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('[data-action="cancel-agent"]').waitFor();
    const busy = await page.evaluate(async (id) => {
      try {
        await window.studio.invoke('meeting:delete', id);
        return '';
      } catch (error) {
        return error.message;
      }
    }, fixture.currentId);
    assert.match(busy, /Agent 工作/);
    await page.locator('[data-action="cancel-agent"]').click();
    await page.locator('[data-action="run-agent"]').waitFor();
    const recordingId = await page.evaluate(
      (id) => window.studio.invoke('audio:start', id),
      fixture.currentId
    );
    await page.locator('.record-strip [data-delete-meeting]').click();
    await page.locator('#confirm-delete-meeting').click();
    await page
      .locator('#toasts')
      .getByText(/請先結束此會議/)
      .waitFor();
    await page.locator('#cancel-delete-meeting').click();
    await page.evaluate((id) => window.studio.invoke('audio:finish', id, 0), recordingId);
    await page.locator('.record-strip [data-delete-meeting]').click();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.locator('#modal').screenshot({ path: 'output/playwright/delete-meeting.png' });
    await page.locator('#confirm-delete-meeting').click();
    await page.getByRole('heading', { name: '總覽', exact: true }).waitFor();
    assert.equal(await page.locator('#notes-editor').count(), 0);
    const data = await page.evaluate(() => window.studio.invoke('bootstrap'));
    assert.equal(data.projects.length, 1);
    assert.equal(data.meetings.length, 1);
    assert.equal(data.meetings[0].id, previousId);
    await assert.rejects(
      fs.access(path.join(profile, 'conversations', `${fixture.currentId}.jsonl`))
    );
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    assert.equal((await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings.length, 1);
    assert.deepEqual(errors, []);
    console.log(
      'Meeting lifecycle/history passed: cancel/delete from list and editor, running-work guards, asset cleanup, preserved project, restart persistence and real Agent search/read/citation tool loop.'
    );
  } finally {
    heldResponse?.end();
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
