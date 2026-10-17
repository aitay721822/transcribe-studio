const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

async function main() {
  let healthy = false;
  let fallback = 0;
  let wsConnections = 0;
  let rtcConnections = 0;
  let page;
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body = `${body}${part}`;
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/rtc') {
      fallback++;
      response.end(JSON.stringify({ text: '斷線缺口已補辨識' }));
      return;
    }
    rtcConnections++;
    const offer = JSON.parse(body);
    const answer = await page.evaluate(
      async ({ offer, attempt }) => {
        const peer = new RTCPeerConnection();
        (window.recoveryPeers ||= []).push(peer);
        peer.ondatachannel = (event) => {
          event.channel.onopen = () =>
            event.channel.send(
              JSON.stringify({
                id: `rtc-${attempt}`,
                text: `WebRTC 第${attempt}次連線`,
                final: true,
              })
            );
        };
        await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
        await peer.setLocalDescription(await peer.createAnswer());
        if (peer.iceGatheringState !== 'complete')
          await new Promise((resolve) => {
            peer.onicegatheringstatechange = () => {
              if (peer.iceGatheringState === 'complete') resolve();
            };
          });
        return { type: 'answer', sdp: peer.localDescription.sdp };
      },
      { offer, attempt: rtcConnections }
    );
    response.end(JSON.stringify(answer));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (!healthy) {
      socket.end('HTTP/1.1 503 Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws));
  });
  sockets.on('connection', (ws) => {
    wsConnections++;
    let bytes = 0;
    ws.on('message', (raw, binary) => {
      if (!binary) return;
      bytes += raw.length;
      ws.send(
        JSON.stringify({
          id: 'live',
          text: `恢復連線${wsConnections}`,
          final: true,
          start: 0,
          end: bytes / 48000,
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    STUDIO_TEST_DATA: await fs.mkdtemp(path.join(os.tmpdir(), 'studio-recovery-ui-')),
  };
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
    await app.evaluate(({ app, systemPreferences }) => {
      if (!app.commandLine.hasSwitch('use-fake-device-for-media-stream'))
        throw new Error('Recovery integration requires a synthetic microphone');
      if (process.platform !== 'darwin') return;
      // Chromium's fake microphone does not grant macOS TCC permission. Only this
      // synthetic-media suite supplies consent; production permission checks stay intact.
      const status = systemPreferences.getMediaAccessStatus.bind(systemPreferences);
      systemPreferences.getMediaAccessStatus = (kind) =>
        kind === 'microphone' ? 'granted' : status(kind);
    });
    page = await require('../setup/helpers.cjs').desktopWindow(app);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await require('../setup/helpers.cjs').overview(page);
    const project = await page.evaluate(async (origin) => {
      const settings = (await window.studio.invoke('bootstrap')).settings;
      settings.asr.provider = 'websocket';
      settings.asr.url = `${origin.replace('http:', 'ws:')}/live`;
      settings.asr.sampleRate = 24000;
      settings.asr.fileUrl = `${origin}/file`;
      settings.asr.fileApiKey = '';
      await window.studio.invoke('settings:save', settings);
      return window.studio.invoke('project:create', '可恢復連線');
    }, origin);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);

    const record = async (title, recordOnly = false) => {
      await page.locator(`[data-project="${project.id}"]`).click();
      await page.locator('[data-action="project-live"]').click();
      await page.waitForFunction(() => !document.querySelector('#audio-device')?.disabled);
      await page.locator('#audio-device-playback').selectOption('none');
      await page.locator('#audio-device').selectOption('mic:');
      await page.locator('#record-only').setChecked(recordOnly);
      await page.locator('[data-action="new-meeting"]').click();
      await page.locator('#name-input').fill(title);
      await page.locator('#name-confirm').click();
      await page.locator('[data-action="stop-recording"]').waitFor();
    };

    await record('WebSocket 故障恢復');
    await page.locator('[data-connection-state="waiting_retry"]').waitFor();
    assert(await page.locator('[data-action="stop-recording"]').isEnabled());
    await page
      .locator('.asr-connections')
      .getByRole('button', { name: '暫停即時連線', exact: true })
      .click();
    await page.locator('[data-connection-state="paused"]').waitFor();
    await page.waitForFunction(() => {
      const timer = document.querySelector('#record-timer')?.textContent || '0';
      return timer.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) >= 2;
    });
    healthy = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    assert.equal(wsConnections, 0);
    await page
      .locator('.asr-connections')
      .getByRole('button', { name: '繼續即時連線', exact: true })
      .click();
    await page.locator('[data-connection-state="connected"]').waitFor();
    await page.getByText('恢復連線1', { exact: true }).waitFor();
    for (const socket of sockets.clients) socket.terminate();
    await page.locator('[data-connection-state="waiting_retry"]').waitFor();
    await page
      .locator('.asr-connections')
      .getByRole('button', { name: '立即重連', exact: true })
      .click();
    await page.getByText('恢復連線2', { exact: true }).waitFor();
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    const first = (await page.evaluate(() => window.studio.invoke('bootstrap'))).meetings.find(
      (meeting) => meeting.title === 'WebSocket 故障恢復'
    );
    assert(first.recordings[0].bytes > 0);
    assert(first.segments.some((segment) => segment.text === '恢復連線2'));

    await page.evaluate(async (origin) => {
      const settings = (await window.studio.invoke('bootstrap')).settings;
      settings.asr.provider = 'webrtc';
      settings.asr.signalingUrl = `${origin}/rtc`;
      await window.studio.invoke('settings:save', settings);
    }, origin);
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    await record('WebRTC 重新協商');
    await page.getByText('WebRTC 第1次連線', { exact: true }).waitFor();
    await page
      .locator('.asr-connections')
      .getByRole('button', { name: '暫停即時連線', exact: true })
      .click();
    await page.locator('[data-connection-state="paused"]').waitFor();
    await page
      .locator('.asr-connections')
      .getByRole('button', { name: '繼續即時連線', exact: true })
      .click();
    await page.getByText('WebRTC 第2次連線', { exact: true }).waitFor();
    assert.equal(rtcConnections, 2);
    assert.equal(await page.evaluate(() => window.recoveryPeers.length), 2);
    // The fake microphone starts with silence; capture voiced PCM before testing range review.
    await page.waitForFunction(() => {
      const timer = document.querySelector('#record-timer')?.textContent || '0';
      return timer.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) >= 2;
    });
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    // The provider omitted timing. Keep backup visible for range review, never append it blindly.
    await page.locator(`.sidebar [data-project="${project.id}"]`).click();
    assert.equal(await page.locator('.sidebar [data-view="tasks"]').count(), 0);
    await page.locator('.project-overview .asr-task-panel').waitFor();
    await page.locator('[data-task-id][data-state="needs_attention"]').first().waitFor();
    await page.getByRole('button', { name: '從原始錄音選擇補辨識範圍' }).first().click();
    await page.locator('#recovery-start').waitFor();
    await page.locator('[data-close-modal]').click();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/asr-recovery-review.png' });
    await require('../setup/helpers.cjs').resizeWindow(app, page, 480, 820);
    assert(
      await page
        .locator('.asr-task-panel')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    );
    await page.screenshot({ path: 'output/playwright/asr-recovery-compact.png' });
    await require('../setup/helpers.cjs').resizeWindow(app, page, 1280, 900);
    await record('重載保留原始錄音', true);
    await page.waitForFunction(() => {
      const timer = document.querySelector('#record-timer')?.textContent || '0';
      return timer.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) >= 2;
    });
    await page.reload();
    await require('../setup/helpers.cjs').overview(page);
    const interrupted = (
      await page.evaluate(() => window.studio.invoke('bootstrap'))
    ).meetings.find((meeting) => meeting.title === '重載保留原始錄音');
    assert.equal(interrupted.status, 'interrupted');
    assert(interrupted.recordings[0].bytes > 0);
    assert.deepEqual(await page.evaluate(() => window.studio.invoke('asr:connections')), []);
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.locator(`[data-meeting="${interrupted.id}"]`).first().click();
    await page.locator('[data-source-tab="audio"]').click();
    await page
      .getByText('上次錄音中斷，可嘗試播放已保存部分，或選擇範圍補辨識；未保存的尾端無法恢復。')
      .waitFor();
    await page.locator('[data-retranscribe]').first().click();
    await page.locator('#recovery-start').waitFor();
    await page.locator('[data-close-modal]').click();
    await record('磁碟寫入失敗自動停止', true);
    await app.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs');

      globalThis.originalAudioWrite = fs.writeSync;
      fs.writeSync = (fd, buffer, offset, length) => {
        if (typeof offset === 'number' && typeof length === 'number') {
          const error = new Error('simulated full disk');
          error.code = 'ENOSPC';
          throw error;
        }
        return globalThis.originalAudioWrite(fd, buffer, offset, length);
      };
    });
    await page.getByText(/本地錄音寫入失敗，已停止收音/).waitFor();
    await page.locator('[data-action="stop-recording"]').waitFor({ state: 'detached' });
    await app.evaluate(() => {
      process.getBuiltinModule('node:fs').writeSync = globalThis.originalAudioWrite;
    });
    const failedRecording = (
      await page.evaluate(() => window.studio.invoke('bootstrap'))
    ).meetings.find((meeting) => meeting.title === '磁碟寫入失敗自動停止');
    assert.equal(failedRecording.status, 'interrupted');
    assert.equal(failedRecording.recordings[0].complete, false);
    assert.deepEqual(errors, []);
    assert(wsConnections >= 2);
    assert(fallback > 0, 'Unconfirmed offline audio must reach the configured background service');
    console.log(
      'Realtime recovery UI passed: offline recording, visible retry, pause/online/resume, new WebSocket and WebRTC peers, preserved recording, manual range review and compact layout.'
    );
  } finally {
    await app.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
