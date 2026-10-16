const { _electron } = require('playwright');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-processing-ui-'));
  const file = path.join(profile, '背景降噪測試.wav');
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
      '600',
      file,
    ],
    { windowsHide: true, encoding: 'utf8' }
  );
  assert.equal(encoded.status, 0, encoded.stderr);
  let hold = true;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain multipart data */
    }
    if (hold) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '背景辨識完成' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, STUDIO_TEST_DATA: profile, TEMP: profile, TMP: profile };
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
    const project = await page.evaluate(async (port) => {
      const project = await window.studio.invoke('project:create', '背景音訊處理');
      const settings = (await window.studio.invoke('bootstrap')).settings;
      settings.asr.fileUrl = `http://127.0.0.1:${port}/audio/transcriptions`;
      settings.asr.fileApiKey = '';
      await window.studio.invoke('settings:save', settings);
      return project;
    }, server.address().port);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator('[data-action="project-import"]').click();
    assert.equal(await page.locator('[data-audio-denoise]').isChecked(), true);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.evaluate(() => {
      window.processingEvents = [];
      window.processingFrames = [];
      window.studio.on('audio:progress', (event) => window.processingEvents.push(event));
      let previous = performance.now();

      function tick(now) {
        window.processingFrames.push({
          gap: now - previous,
          stage: document.querySelector('.audio-job')?.dataset.stage,
        });
        previous = now;
        requestAnimationFrame(tick);
      }

      requestAnimationFrame(tick);
    });
    await page.locator('[data-action="pick-files"]').click();
    await page.locator('[data-action="transcribe-files"]').click();
    await page.locator('.audio-job[data-stage="denoise"]').waitFor();
    // Exercise real controls while FFmpeg is doing DSP.
    await page.keyboard.press('Control+k');
    await page.locator('#palette-query').fill('背景');
    await page.keyboard.press('Escape');
    const start = Date.now();
    await page.evaluate(() => window.studio.invoke('bootstrap'));
    assert(Date.now() - start < 1500, 'main-process IPC stays responsive');
    await page.locator('.audio-job[data-stage="transcribe"]').waitFor();
    const job = (await page.evaluate(() => window.studio.invoke('audio:jobs')))[0];
    await assert.rejects(
      page.evaluate((id) => window.studio.invoke('audio:start', id), job.meetingId),
      /辨識/
    );
    const events = await page.evaluate(() => window.processingEvents);
    assert.deepEqual(
      [...new Set(events.map((event) => event.stage))],
      ['decode', 'denoise', 'segment', 'transcribe']
    );
    const frames = await page.evaluate(() =>
      window.processingFrames.filter((frame) =>
        ['decode', 'denoise', 'segment'].includes(frame.stage)
      )
    );
    assert(
      frames.length >= 3 && Math.max(...frames.map((frame) => frame.gap)) < 750,
      'renderer keeps drawing during CPU work'
    );
    await fs.mkdir('output/playwright', { recursive: true });
    await page.locator('.audio-job').screenshot({ path: 'output/playwright/audio-processing.png' });
    // Reload must reconnect to the existing job without restarting preprocessing.
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator('[data-action="project-import"]').click();
    await page.locator('.audio-job[data-stage="transcribe"]').waitFor();
    assert.equal((await page.evaluate(() => window.studio.invoke('audio:jobs'))).length, 1);
    await page.locator('[data-cancel-audio]').click();
    await page.locator('.audio-job[data-stage="cancelled"]').waitFor();
    assert.equal(await page.locator('.audio-job [role="progressbar"]').count(), 0);
    // Disabling denoising is retained and the remaining stages still finish normally.
    hold = false;
    await page.locator('[data-audio-denoise]').uncheck();
    const short = path.join(profile, '短音檔.wav');
    const small = spawnSync(
      require('ffmpeg-static'),
      ['-nostdin', '-v', 'error', '-i', file, '-t', '1', short],
      { windowsHide: true }
    );
    assert.equal(small.status, 0);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, short);
    await page.locator('[data-action="pick-files"]').click();
    await page.locator('[data-action="transcribe-files"]').click();
    await page.locator('.audio-job[data-stage="completed"]').waitFor();
    assert.equal(
      await page.locator('.audio-job[data-stage="completed"]').getByText('略過降噪').count(),
      1
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 700));
    await page.waitForFunction(() => innerWidth === 480);
    assert(
      await page.evaluate(() =>
        [...document.querySelectorAll('.audio-job')].every(
          (card) => card.scrollWidth <= card.clientWidth
        )
      )
    );
    const invalid = path.join(profile, '損毀音檔.wav');
    await fs.writeFile(invalid, 'invalid audio');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, invalid);
    await page.locator('[data-action="pick-files"]').click();
    await page.locator('[data-action="transcribe-files"]').click();
    await page.locator('.audio-job[data-stage="failed"]').waitFor();
    assert.equal(
      await page.locator('.audio-job[data-stage="failed"] [role="progressbar"]').count(),
      0
    );
    hold = true;
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.locator('[data-action="pick-files"]').click();
    await page.locator('[data-action="transcribe-files"]').click();
    await page.locator('.audio-job[data-stage="transcribe"]').waitFor();
    assert.deepEqual(errors, []);
    console.log(
      'Audio processing UI passed: four real background stages, denoise toggle, responsive renderer/IPC, reload recovery, cancellation, completion/failure and narrow layout.'
    );
  } finally {
    await app.close();
    assert.deepEqual(
      (await fs.readdir(profile)).filter((name) => name.startsWith('studio-audio-work-')),
      [],
      'app shutdown releases worker audio'
    );
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
