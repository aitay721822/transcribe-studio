const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { transcriptionServer } = require('./server.cjs');
const { pcmWav } = require('../../../dist/transport/transcription/wav.cjs');

async function main() {
  const service = await transcriptionServer();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-speech-services-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: [
      ...(process.env.STUDIO_PACKAGED ? [] : ['.']),
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    env,
  });
  try {
    const page = await require('../setup/helpers.cjs').desktopWindow(app),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('.setup-screen').waitFor();
    const offlineTab = page.getByRole('tab', { name: '離線辨識（必填）' });
    const realtimeTab = page.getByRole('tab', { name: '即時辨識（選用）' });
    assert.equal(await page.getByRole('tab').count(), 2);
    assert.equal(await offlineTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#setup-asr-realtime-enabled').isChecked(), false);
    assert.equal(await page.locator('#setup-asr-url').isVisible(), false);
    await realtimeTab.click();
    await page.locator('#setup-asr-url').fill(service.live);
    await page.locator('#setup-asr-key').fill('realtime-test-key');
    await page.locator('#setup-asr-model').fill('local-realtime-model');
    await page.locator('#setup-asr-realtime-enabled').check();
    await page.locator('#setup-next').click();
    await page.getByText('請先完成必填的離線辨識設定：HTTP 端點、模型及服務所需的驗證').waitFor();
    assert.equal(await page.locator('.hero').count(), 0);
    await offlineTab.click();
    await page.locator('#setup-asr-file-url').fill(service.offline);
    await page.locator('#setup-asr-file-key').fill('file-test-key');
    await page.locator('#setup-asr-file-model').fill('local-file-model');
    await page.locator('#setup-asr-chunk-seconds').selectOption('2');
    await offlineTab.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await realtimeTab.getAttribute('aria-selected'), 'true');
    await page.locator('#setup-asr-flavor').selectOption('vllm');
    assert.equal(await realtimeTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#setup-asr-model').inputValue(), 'local-realtime-model');
    await page.locator('#setup-asr-realtime-enabled').uncheck();
    await realtimeTab.focus();
    await page.keyboard.press('Home');
    assert.equal(await offlineTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#setup-asr-file-model').inputValue(), 'local-file-model');
    await page.locator('#setup-test-offline').click();
    await page.locator('#connection-start').click();
    await page
      .locator('.connection-transcript .final')
      .filter({ hasText: 'HTTP 辨識段落' })
      .waitFor();
    assert.equal(service.uploads[0].auth, 'Bearer file-test-key');
    assert.equal(service.uploads[0].model, 'local-file-model');
    assert.equal(service.uploads[0].path, '/v1/audio/transcriptions?route=file');
    assert.equal(service.uploads[0].bytes.readUInt32LE(24), 24000);
    await page.locator('#connection-stop').click();
    await page.locator('#connection-start').waitFor();
    await page.locator('[data-close-modal]').click();
    await realtimeTab.click();
    await page.locator('#setup-test-realtime').click();
    await page.locator('#connection-start').click();
    await page
      .locator('.connection-transcript .partial')
      .filter({ hasText: 'vLLM 即時文字' })
      .waitFor();
    await page.locator('#connection-stop').click();
    await page
      .locator('.connection-transcript .final')
      .filter({ hasText: 'vLLM 即時文字完成' })
      .waitFor();
    await page.locator('#connection-start').waitFor();
    assert.equal(service.realtime[0].auth, 'Bearer realtime-test-key');
    assert.equal(service.realtime[0].path, '/v1/realtime');
    assert.deepEqual(service.realtime[0].events[0], {
      type: 'session.update',
      model: 'local-realtime-model',
    });
    assert.equal(service.realtime[0].events.at(-1).final, true);
    await page.locator('[data-close-modal]').click();
    assert.equal((await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings.length, 0);
    await page.locator('#setup-next').click();
    await page.locator('#setup-llm-key').fill('agent-test-key');
    await page.locator('#setup-llm-model').fill('local-agent');
    await page.locator('#setup-next').click();
    await page.locator('#setup-next').click();
    await page.locator('.hero').waitFor();
    const saved = (await page.evaluate(() => window.studio.invoke('bootstrap'))).settings;
    assert.equal(saved.asr.fileApiKey, '••••••••');
    assert.equal(saved.asr.apiKey, '••••••••');
    assert.equal(saved.asr.fileUrl, service.offline);
    assert.equal(saved.asr.url, service.live);
    assert.equal(saved.asr.provider, 'transcriptions');
    const { DatabaseSync } = require('node:sqlite');

    const db = new DatabaseSync(path.join(profile, 'studio.sqlite'));
    const stored = db.prepare('SELECT data FROM settings').get().data;
    db.close();
    assert(!stored.includes('file-test-key') && !stored.includes('realtime-test-key'));
    const project = await page.evaluate(() =>
      window.studio.invoke('project:create', '兩類辨識服務')
    );
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator('[data-action="project-live"]').click();
    await page.waitForFunction(() => document.querySelector('#audio-device')?.disabled === false);
    await page.locator('[data-action="new-meeting"]').click();
    await page.locator('#name-input').fill('HTTP 分段收音');
    await page.locator('#name-confirm').click();
    await page.locator('#source-body').filter({ hasText: 'HTTP 辨識段落' }).waitFor();
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    const recorded = (await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings[0];
    assert(recorded.segments.length >= 1 && recorded.recordings[0].bytes > 0);
    assert(recorded.segments.every((s) => s.final && s.recordingId === recorded.recordings[0].id));
    const before = service.uploads.length;
    await page.evaluate(
      async ({ id, rid }) => window.studio.invoke('recording:transcribe', id, rid),
      { id: recorded.id, rid: recorded.recordings[0].id }
    );
    assert.equal(service.uploads.length, before + 1);
    assert.equal(service.uploads.at(-1).name, 'recording-001.wav');
    assert.equal(service.uploads.at(-1).bytes.readUInt32LE(24), 16000);
    assert.equal(service.uploads.at(-1).auth, 'Bearer file-test-key');
    assert.equal(service.uploads.at(-1).language, 'zh');
    const fixture = path.join(profile, 'sample.wav'),
      pcm = Buffer.alloc(65.25 * 16000 * 2);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(6000, i);
    await fs.writeFile(fixture, pcmWav(pcm, 16000));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, fixture);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator('[data-action="project-import"]').click();
    await page.locator('[data-audio-denoise]').uncheck();
    await page.locator('[data-action="pick-files"]').click();
    await page.locator('[data-action="transcribe-files"]').click();
    await page.getByText('sample.wav 已完成', { exact: true }).waitFor();
    assert.deepEqual(
      service.uploads.slice(-3).map((u) => u.name),
      ['sample-001.wav', 'sample-002.wav', 'sample-003.wav']
    );
    const imported = (await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings.find(
      (m) => m.title === 'sample'
    );
    assert.equal(imported.duration, 65.25);
    assert.deepEqual(
      imported.segments.map((s) => [s.start, s.end]),
      [
        [0, 30],
        [29, 59],
        [58, 65.25],
      ]
    );
    await page.locator('[data-view="settings"]').click();
    assert.equal(await page.getByRole('tab').count(), 2);
    assert.equal(await page.locator('#asr-file-url').inputValue(), service.offline);
    assert.equal(await page.locator('#asr-url').inputValue(), service.live);
    await page.locator('[data-action="save-settings"]').click();
    await page.getByText('設定已儲存', { exact: true }).waitFor();
    await page.evaluate(() =>
      document.querySelectorAll('#toasts button').forEach((b) => b.click())
    );
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/speech-services.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 700));
    await page.waitForFunction(() => innerWidth === 480);
    assert(await page.locator('#asr-file-url').isVisible());
    assert(
      await page.evaluate(
        () =>
          document.querySelector('.settings-content').scrollWidth <=
          document.querySelector('.settings-content').clientWidth
      )
    );
    await realtimeTab.click();
    await page.locator('#asr-realtime-enabled').check();
    await page.locator('[data-action="save-settings"]').click();
    await page.getByText('設定已儲存', { exact: true }).waitFor();
    assert.equal(
      (await page.evaluate(() => window.studio.invoke('bootstrap'))).settings.asr.provider,
      'openai'
    );
    await page.locator('#asr-realtime-enabled').uncheck();
    await page.locator('#asr-url').fill('');
    await page.locator('#asr-model').fill('');
    await page.locator('#asr-key').fill('');
    await page.locator('[data-action="save-settings"]').click();
    await page.waitForFunction(
      async () =>
        (await window.studio.invoke('bootstrap')).settings.asr.provider === 'transcriptions'
    );
    assert.equal(await page.locator('.setup-screen').count(), 0);
    await offlineTab.click();
    await page.locator('#asr-file-model').fill('');
    await page.locator('[data-action="save-settings"]').click();
    await page.locator('.setup-screen').waitFor();
    await page.reload();
    await page.locator('.setup-screen').waitFor();
    assert.equal(await offlineTab.getAttribute('aria-selected'), 'true');
    await page.locator('#setup-next').click();
    await page.getByText('請先完成必填的離線辨識設定：HTTP 端點、模型及服務所需的驗證').waitFor();
    await page.locator('#setup-asr-file-model').fill('local-file-model');
    await page.locator('#setup-next').click();
    await page.locator('#setup-next').click();
    await page.locator('#setup-next').click();
    await page.locator('.project-overview').waitFor();
    assert.equal(await page.locator('.setup-screen').count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Speech services UI passed: accessible tabs and retained drafts, mandatory offline setup/revocation, optional realtime enable/disable, independent credentials, both microphone tests, HTTP live/file/retry, vLLM and compact layout.'
    );
  } finally {
    await app.close();
    await service.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
