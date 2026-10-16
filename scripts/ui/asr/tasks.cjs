const { _electron } = require('playwright');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-task-ui-'));
  const file = path.join(profile, '服務恢復測試.wav');
  const encoded = spawnSync(
    require('ffmpeg-static'),
    [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000',
      '-t',
      '2',
      file,
    ],
    { windowsHide: true }
  );
  assert.equal(encoded.status, 0);
  let healthy = false;
  let transcript = '服務恢復後的完整逐字稿';
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(Date.now());
    for await (const _chunk of request) {
      /* drain multipart audio */
    }
    response.setHeader('Content-Type', 'application/json');
    if (!healthy) {
      response.statusCode = 503;
      response.setHeader('Retry-After', '2');
      response.end(JSON.stringify({ error: { message: 'private upstream details' } }));
      return;
    }
    response.end(JSON.stringify({ text: transcript }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;

  const launch = () =>
    _electron.launch({
      ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
      args: process.env.STUDIO_PACKAGED ? [] : ['.'],
      env,
    });

  let app = await launch();
  try {
    let page = await require('../setup/helpers.cjs').desktopWindow(app);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await require('../setup/helpers.cjs').overview(page);
    const project = await page.evaluate(async (port) => {
      const settings = (await window.studio.invoke('bootstrap')).settings;
      settings.asr.fileUrl = `http://127.0.0.1:${port}/transcribe`;
      settings.asr.fileApiKey = '';
      await window.studio.invoke('settings:save', settings);
      return window.studio.invoke('project:create', '可管理的辨識任務');
    }, server.address().port);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator('[data-action="project-import"]').click();
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, file);

    const enqueue = async () => {
      await page.locator('[data-action="pick-files"]').click();
      await page.locator('[data-action="transcribe-files"]').click();
    };

    await enqueue();
    await page.locator('.asr-task-card[data-state="waiting_retry"]').waitFor();
    assert.match(await page.locator('.asr-task-retry').textContent(), /秒後重試/);
    assert.equal(await page.getByText('private upstream details').count(), 0);
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/asr-tasks-waiting.png' });
    const task = (await page.evaluate(() => window.studio.invoke('asr:tasks'))).items[0];
    await page.locator('.asr-task-card').getByRole('button', { name: '暫停', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.locator('.asr-task-card[data-state="paused"]').waitFor();
    await page.getByRole('button', { name: '管理此專案任務', exact: true }).click();
    assert.equal(await page.locator('.sidebar [data-view="tasks"]').count(), 0);
    await page.locator('.project-overview .asr-task-panel').waitFor();
    assert.equal(await page.locator('#tasks-project').count(), 0);
    await page.locator('#tasks-source').selectOption('import');
    await page.locator('#tasks-state').selectOption('paused');
    const card = page.locator('.asr-task-card');
    await card.waitFor();
    await card.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: '批次重試', exact: true }).click();
    await page.locator('.asr-task-card[data-state="paused"]').waitFor();
    await page.getByRole('button', { name: '暫停全部背景任務', exact: true }).click();
    await page.getByText('背景任務已暫停；錄音與即時辨識繼續。', { exact: true }).waitFor();
    await card.getByRole('button', { name: '繼續', exact: true }).click();
    await page.locator('#tasks-state').selectOption('');
    await page.locator('.asr-task-card[data-state="waiting_retry"]').waitFor();
    const before = requests.length;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page
      .locator('.asr-task-card')
      .getByRole('button', { name: '暫停', exact: true })
      .waitFor();
    assert.equal(requests.length, before);
    healthy = true;
    await page.getByRole('button', { name: '繼續背景任務', exact: true }).click();
    await page.locator('.asr-task-card[data-state="completed"]').waitFor();
    await page.getByText('檢視已完成與未辨識範圍', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByText(/00:00:00–00:00:02 · 已完成/).waitFor();
    assert(
      requests[1] - requests[0] >= 1900,
      'Retry-After remains effective across manual actions'
    );
    const complete = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      task.meetingId
    );
    assert.equal(complete.segments.length, 1);
    assert.equal(complete.segments[0].text, '服務恢復後的完整逐字稿');
    const recordingFile = path.join(profile, 'audio', `${complete.recordings[0].id}.wav`);
    await page
      .locator('.asr-task-card')
      .getByRole('button', { name: '刪除任務', exact: true })
      .click();
    await page.getByText('目前沒有符合的辨識任務。', { exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(recordingFile), await fs.readFile(file));
    assert.equal(
      (await page.evaluate((id) => window.studio.invoke('meeting:get', id), task.meetingId))
        .segments.length,
      1
    );
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator(`[data-meeting="${task.meetingId}"]`).first().click();
    await page.locator('[data-source-tab="audio"]').click();
    await page.locator('[data-retranscribe]').first().click();
    await page.locator('#recovery-start').fill('0.5');
    await page.locator('#recovery-end').fill('1.5');
    const submit = page.getByRole('button', { name: '加入補辨識任務', exact: true });
    assert(await submit.isDisabled());
    await page.getByRole('button', { name: '擴展到完整逐字稿範圍' }).click();
    assert.equal(await page.locator('#recovery-start').inputValue(), '0');
    assert.equal(await page.locator('#recovery-end').inputValue(), '2');
    assert(await submit.isDisabled());
    await page.getByRole('checkbox', { name: '確認替換此範圍內的既有逐字稿' }).check();
    transcript = '人工確認後替換的逐字稿';
    await submit.click();
    await require('./wait.cjs').waitTask(
      page,
      { meetingId: task.meetingId, source: 'recording' },
      'completed'
    );
    const replaced = await page.evaluate(
      (id) => window.studio.invoke('meeting:get', id),
      task.meetingId
    );
    assert.equal(replaced.segments.length, 1);
    assert.equal(replaced.segments[0].text, transcript);
    assert.deepEqual(await fs.readFile(recordingFile), await fs.readFile(file));
    await page.evaluate(async (id) => {
      const tasks = await window.studio.invoke('asr:tasks', { meetingId: id });
      await window.studio.invoke(
        'asr:task-action',
        tasks.items.map((item) => item.id),
        'delete'
      );
    }, task.meetingId);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator('[data-action="project-import"]').click();
    await page.evaluate(() => window.studio.invoke('asr:background', true));
    await enqueue();
    await enqueue();
    await page.locator(`.sidebar [data-project="${project.id}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('.asr-task-card').length === 2);
    await page.getByRole('checkbox', { name: '選取本頁全部任務', exact: true }).check();
    await page.getByRole('button', { name: '批次刪除', exact: true }).click();
    await page.getByText('目前沒有符合的辨識任務。', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings.length, 3);
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/asr-tasks-desktop.png' });
    // Each project owns its task view, filters and bulk selection across navigation.
    await page.locator('[data-action="project-import"]').click();
    await enqueue();
    const otherProject = await page.evaluate(() =>
      window.studio.invoke('project:create', '另一個專案的辨識任務')
    );
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`.sidebar [data-project="${otherProject.id}"]`).click();
    await page.locator('[data-action="project-import"]').click();
    await enqueue();
    for (const current of [project, otherProject, project]) {
      await page.locator(`.sidebar [data-project="${current.id}"]`).click();
      await page.waitForFunction(() => document.querySelectorAll('.asr-task-card').length === 1);
      const visibleId = await page.locator('.asr-task-card').getAttribute('data-task-id');
      const own = await page.evaluate(
        (projectId) => window.studio.invoke('asr:tasks', { projectId }),
        current.id
      );
      assert.equal(own.total, 1);
      assert.equal(visibleId, own.items[0].id);
      const allowedMeetings = await page
        .locator('#tasks-meeting option')
        .evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
      const meetings = (await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings;
      assert(
        allowedMeetings.every(
          (id) => meetings.find((item) => item.id === id)?.projectId === current.id
        )
      );
      assert.equal(
        await page.getByRole('checkbox', { name: '選取本頁全部任務' }).isChecked(),
        false
      );
      await page.getByRole('checkbox', { name: '選取本頁全部任務' }).check();
    }
    await page.evaluate(async () => {
      const tasks = await window.studio.invoke('asr:tasks');
      await window.studio.invoke(
        'asr:task-action',
        tasks.items.map((item) => item.id),
        'delete'
      );
    });
    await page.getByText('目前沒有符合的辨識任務。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await app.close();
    app = await launch();
    page = await require('../setup/helpers.cjs').desktopWindow(app);
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`.sidebar [data-project="${project.id}"]`).click();
    await page.getByText('目前沒有符合的辨識任務。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '繼續背景任務', exact: true }).count(), 1);
    const state = await page.evaluate(() => window.studio.invoke('asr:tasks'));
    assert.equal(state.total, 0);
    assert.equal(state.backgroundPaused, true);
    await require('../setup/helpers.cjs').resizeWindow(app, page, 480, 820);
    assert(
      await page
        .locator('.asr-task-panel')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    );
    await page.screenshot({ path: 'output/playwright/asr-tasks-compact.png' });
    console.log(
      'ASR task UI passed: visible retry/deadline, filters, manual/bulk controls, original preservation, recovery, restart and compact layout.'
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
