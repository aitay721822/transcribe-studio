const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-queue-ui-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const bodies = [];
  const responses = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw = `${raw}${chunk}`;
    bodies.push(JSON.parse(raw));
    responses.push(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });

  const respond = (index) => {
    responses[index].setHeader('Content-Type', 'application/json');
    responses[index].end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `# proposal ${index}` }],
          },
        ],
      })
    );
  };

  try {
    await require('./helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('.setup-page').waitFor();
    const meeting = await page.evaluate(async (port) => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.asr.apiKey = 'test';
      s.asr.fileUrl = 'http://127.0.0.1:1/v1/audio/transcriptions';
      s.asr.fileApiKey = 'test';
      s.llm.apiKey = 'test';
      s.llm.model = 'test';
      s.llm.baseUrl = `http://127.0.0.1:${port}`;
      await window.studio.invoke('settings:save', s);
      const p = await window.studio.invoke('project:create', 'queue project');
      return window.studio.invoke('meeting:create', p.id, 'queue meeting', 'file');
    }, server.address().port);
    await page.reload();
    await page.locator('.hero').waitFor();
    await page.locator(`.meeting-row[data-meeting="${meeting.id}"]`).click();
    await page.locator('#agent-input').fill('保留換行');
    await page.locator('#agent-input').press('Shift+Enter');
    assert.equal(await page.locator('#agent-input').inputValue(), '保留換行\n');
    assert.equal(bodies.length, 0);
    assert.equal(await page.locator('.slash-hint').count(), 0);
    await page.locator('#agent-input').fill('first');
    await page.locator('#agent-input').press('Enter');
    await page.locator('[data-action="cancel-agent"]').waitFor();
    assert.equal(await page.locator('#agent-send-actions button').count(), 1);
    assert.equal(
      await page.locator('[data-action="queue-agent"], [data-action="steer-agent"]').count(),
      0
    );
    while (bodies.length < 1) await new Promise((r) => setTimeout(r, 10));
    await page.locator('#agent-input').fill('輸入法確認');
    await page
      .locator('#agent-input')
      .dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
    await page.locator('#agent-input').dispatchEvent('keydown', { key: 'Enter', repeat: true });
    assert.equal(await page.locator('#agent-input').inputValue(), '輸入法確認');
    assert.equal(await page.locator('.chat-user').count(), 1);
    await page.locator('#agent-input').fill('queued follow-up');
    await page.locator('#agent-input').press('Control+Enter');
    await page.locator('.agent-queue-item').waitFor();
    assert((await page.locator('#skill-select-trigger').boundingBox()).width >= 100);
    assert.equal(bodies.length, 1);
    await page.locator('#agent-input').fill('remove this');
    await page.locator('#agent-input').press('Control+Enter');
    await page.waitForFunction(() => document.querySelectorAll('.agent-queue-item').length === 2);
    await page.locator('[data-cancel-input]').last().click();
    await page.waitForFunction(() => document.querySelectorAll('.agent-queue-item').length === 1);
    await page.locator('#agent-input').fill('steer now');
    await page.locator('#agent-input').press('Enter');
    await page.getByText('已引導目前工作', { exact: true }).first().waitFor();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/agent-queue-steer.png' });
    respond(0);
    while (bodies.length < 2) await new Promise((r) => setTimeout(r, 10));
    assert(bodies[1].input.some((i) => i.role === 'user' && i.content.includes('steer now')));
    respond(1);
    while (bodies.length < 3) await new Promise((r) => setTimeout(r, 10));
    const followup = JSON.parse(bodies[2].input[0].content);
    assert.equal(followup.request, 'queued follow-up');
    assert.equal(followup.previousUnappliedProposal, '# proposal 1');
    await page.locator('#agent-input').fill('persist after stop');
    await page.locator('#agent-input').press('Control+Enter');
    await page.locator('.agent-queue-item').waitFor();
    await page.locator('[data-action="cancel-agent"]').click();
    await page.locator('[data-action="resume-agent"]').waitFor();
    await page.reload();
    await page.locator('.hero').waitFor();
    await page.locator(`.meeting-row[data-meeting="${meeting.id}"]`).click();
    await page.locator('[data-action="resume-agent"]').waitFor();
    assert.match(await page.locator('.agent-queue-item').textContent(), /persist after stop/);
    await page.locator('[data-action="resume-agent"]').click();
    while (bodies.length < 4) await new Promise((r) => setTimeout(r, 10));
    respond(3);
    await page.locator('[data-action="run-agent"]').waitFor();
    assert.equal(await page.locator('.agent-queue-item').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Agent queue UI passed: send, FIFO, remove, steer during final response, previous proposal, stop, persisted queue, reload and resume.'
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
