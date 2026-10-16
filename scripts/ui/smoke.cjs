const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-electron-'));
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  await fs.mkdir('output/playwright', { recursive: true });
  const packaged = process.env.STUDIO_PACKAGED;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [
      ...(packaged ? [] : ['.']),
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    env,
    timeout: 60000,
  });
  const modelServer = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader('Content-Type', 'application/json');
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
                text: '# Agent 整理完成\n\n## 決議\n- 功能已完成驗證。\n\n| 事項 | 負責人 |\n| --- | --- |\n| 驗證文件 | 待確認 |',
              },
            ],
          },
        ],
      })
    );
  });
  await new Promise((r) => modelServer.listen(0, '127.0.0.1', r));
  const asrServer = new WebSocketServer({ port: 0 });
  await new Promise((r) => asrServer.once('listening', r));
  let pcmBytes = 0;
  asrServer.on('connection', (ws) => {
    let delivered = false;
    ws.on('message', (data, binary) => {
      if (binary) pcmBytes += data.length;
      if (!delivered && binary) {
        delivered = true;
        ws.send(
          JSON.stringify({
            id: 'live-segment',
            text: '這是本地串流辨識測試。',
            final: true,
            start: 0,
            end: 1,
          })
        );
      }
    });
  });
  const errors = [];
  let rtcServer;
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await require('./setup/helpers.cjs').overview(page);
    await page.getByRole('button', { name: '收合專案側欄', exact: true }).click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    await page.getByRole('button', { name: '展開專案側欄', exact: true }).click();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    await page.screenshot({ path: 'output/playwright/overview.png' });
    await page.getByRole('button', { name: '新增專案', exact: true }).click();
    await page.locator('#name-input').fill('產品研發');
    await page.locator('#name-confirm').click();
    await page.getByRole('heading', { name: '產品研發', exact: true }).waitFor();
    const data = await page.evaluate(() => window.studio.invoke('bootstrap'));
    assert.equal(data.projects.length, 1);
    const m = await page.evaluate(async (projectId) => {
      const m = await window.studio.invoke(
        'meeting:create',
        projectId,
        '產品週會 · 會議紀錄',
        'file'
      );
      await window.studio.invoke(
        'meeting:update',
        m.id,
        {
          notes:
            '# 產品週會\n\n## 會議摘要\n確認產品開發的進度與下一階段交付。\n\n## 決議\n- 第一版優先完成即時會議工作台。\n- 專案可加入多個參考資料夾。\n\n## 待辦事項\n| 事項 | 負責人 | 期限 |\n| --- | --- | --- |\n| 驗證音訊串流 | 待確認 | 待確認 |',
        },
        0
      );
      return m;
    }, data.projects[0].id);
    await page.reload();
    await page.locator(`[data-meeting="${m.id}"]`).first().click();
    await page.locator('#notes-editor').waitFor();
    await page.locator('#notes-editor').fill('# 修訂會議紀錄\n\n## 決議\n- 已驗證自動儲存。');
    await page.waitForFunction(() =>
      document.querySelector('#save-status')?.textContent.includes('已儲存')
    );
    const saved = await page.evaluate((id) => window.studio.invoke('meeting:get', id), m.id);
    assert.match(saved.notes, /已驗證自動儲存/);
    assert.equal(saved.version, 2);
    await page.locator('[data-editor-tab="preview"]').click();
    await page.getByRole('heading', { name: '修訂會議紀錄', exact: true }).waitFor();
    await page.locator('[data-editor-tab="edit"]').click();
    await page.screenshot({ path: 'output/playwright/workspace.png' });
    await page.locator('[data-action="revisions"]').click();
    await page.locator('#modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-revision]').count(), 2);
    await page.locator('[data-close-modal]').click();
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('[data-theme-option="dark"]').click();
    await page.locator('[data-action="save-settings"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.locator('[data-action="back-workspace"]').click();
    await page.locator('[data-meeting]').first().click();
    await page.screenshot({ path: 'output/playwright/workspace-dark.png' });
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    await page.locator('#llm-key').fill('');
    await page.locator('[data-action="save-settings"]').click();
    await page.locator('.setup-screen').waitFor();
    assert.equal(await page.locator('.sidebar').count(), 0);
    await require('./setup/helpers.cjs').overview(page);
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    await page.locator('#llm-backend').selectOption('claude');
    await page.locator('#claude-auth').selectOption('api');
    assert.equal(await page.locator('#claude-key').isVisible(), true);
    assert.equal(await page.locator('#llm-key').isVisible(), false);
    await page.locator('#claude-key').fill('anthropic-ui-test-key');
    await page.locator('#claude-model').fill('claude-local-test');
    await page.locator('#llm-backend').selectOption('codex');
    assert.equal(await page.locator('#codex-path').isVisible(), true);
    await page.locator('#llm-backend').selectOption('openai');
    await page.locator('[data-action="save-settings"]').click();
    await page.waitForFunction(
      async () =>
        (await window.studio.invoke('bootstrap')).settings.llm.claudeModel === 'claude-local-test'
    );
    const publicSettings = await page.evaluate(
      async () => (await window.studio.invoke('bootstrap')).settings
    );
    assert.equal(publicSettings.llm.backend, 'openai');
    assert.equal(publicSettings.llm.claudeKey, '••••••••');
    await page.screenshot({ path: 'output/playwright/agent-backends.png' });
    await page.locator('[data-action="back-workspace"]').click();
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    await page.locator('#audio-device').selectOption('mic:');
    await page.locator('#record-only').check();
    await page.locator('[data-action="new-meeting"]').first().click();
    await page.locator('#name-input').fill('錄音測試');
    await page.locator('#name-confirm').click();
    await page.locator('[data-action="stop-recording"]').waitFor();
    await page.waitForFunction(() => {
      const text = document.querySelector('#record-timer')?.textContent;
      return text && text.split(':').reduce((a, n) => a * 60 + Number(n), 0) >= 2;
    });
    await page.locator('[data-action="pause-recording"]').click();
    await page.getByRole('button', { name: '繼續', exact: true }).waitFor();
    await page.getByRole('button', { name: '繼續', exact: true }).click();
    await page.locator('#notes-editor').fill('# 錄音期間的即時筆記');
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    const recorded = await page.evaluate(async () =>
      (await window.studio.invoke('bootstrap')).meetings.find((m) => m.title === '錄音測試')
    );
    assert.equal(recorded.status, 'completed');
    assert(recorded.duration >= 2);
    assert(recorded.recordings[0].bytes > 0);
    assert.match(recorded.notes, /錄音期間的即時筆記/);
    await page.locator('[data-source-tab="audio"]').click();
    await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
    await page.locator('[data-action="start-recording"]').click();
    await page.locator('[data-action="stop-recording"]').waitFor();
    await page.waitForFunction((previous) => {
      const text = document.querySelector('#record-timer')?.textContent;
      if (!text) return false;
      return text.split(':').reduce((a, n) => a * 60 + Number(n), 0) >= previous + 1;
    }, Math.ceil(recorded.duration));
    await page.locator('[data-action="stop-recording"]').click();
    await page.waitForFunction(() => !!document.querySelector('[data-action="start-recording"]'));
    const resumed = await page.evaluate(
      async (id) => window.studio.invoke('meeting:get', id),
      recorded.id
    );
    assert.equal(resumed.recordings.length, 2);
    assert.equal(resumed.recordings[1].offset, recorded.duration);
    assert(resumed.duration > recorded.duration);
    await page.evaluate(async (port) => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.llm = {
        ...s.llm,
        backend: 'openai',
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'local-test',
        apiKey: 'local-key',
        maxSteps: 4,
      };
      await window.studio.invoke('settings:save', s);
    }, modelServer.address().port);
    await page.locator('#agent-input').fill('請整理紀錄');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('[data-action="review-proposal"]').waitFor();
    await page.locator('[data-action="review-proposal"]').click();
    await page.locator('#accept-proposal').click();
    await page.waitForFunction(() =>
      document.querySelector('#notes-editor')?.value.includes('Agent 整理完成')
    );
    await page.locator('#agent-input').fill('再整理一次');
    await page.locator('[data-action="run-agent"]').click();
    await page.locator('[data-action="review-proposal"]').waitFor();
    await page.locator('#notes-editor').fill('# 使用者手動修訂');
    await page.waitForFunction(() =>
      document.querySelector('#save-status')?.textContent.includes('已儲存')
    );
    await page.locator('[data-action="review-proposal"]').click();
    assert.equal(await page.locator('#accept-proposal').isDisabled(), true);
    await page.locator('#reject-proposal').click();
    const exported = path.join(profile, 'meeting.docx');
    await app.evaluate(({ dialog }, exported) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported });
    }, exported);
    await page.locator('[data-action="export"]').click();
    await page.locator('#export-transcript').check();
    await page.locator('#do-export').click();
    await page.getByText(`Word 文件已匯出：${exported}`, { exact: true }).waitFor();
    assert((await fs.stat(exported)).size > 1000);
    await page.evaluate(async (port) => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.asr.provider = 'websocket';
      s.asr.url = `ws://127.0.0.1:${port}`;
      await window.studio.invoke('settings:save', s);
    }, asrServer.address().port);
    await page.reload();
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    await page.locator('#audio-device').selectOption('mic:');
    await page.locator('[data-action="new-meeting"]').first().click();
    await page.locator('#name-input').fill('串流辨識測試');
    await page.locator('#name-confirm').click();
    await page.getByText('這是本地串流辨識測試。', { exact: true }).waitFor();
    assert(pcmBytes > 0);
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    rtcServer = http.createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const b of req) raw = `${raw}${b}`;
        const offer = JSON.parse(raw);
        const answer = await page.evaluate(async (offer) => {
          const peer = new RTCPeerConnection();
          window.rtcTestPeer = peer;
          peer.ondatachannel = (event) => {
            event.channel.onopen = () =>
              event.channel.send(
                JSON.stringify({
                  id: 'rtc-segment',
                  text: 'WebRTC 串流已完成驗證。',
                  final: true,
                  start: 0,
                  end: 1,
                })
              );
          };
          await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
          await peer.setLocalDescription(await peer.createAnswer());
          if (peer.iceGatheringState !== 'complete')
            await new Promise(
              (resolve) =>
                (peer.onicegatheringstatechange = () => {
                  if (peer.iceGatheringState === 'complete') resolve();
                })
            );
          return { type: 'answer', sdp: peer.localDescription.sdp };
        }, offer);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(answer));
      } catch (e) {
        res.statusCode = 500;
        res.end(e.message);
      }
    });
    await new Promise((r) => rtcServer.listen(0, '127.0.0.1', r));
    await page.evaluate(async (port) => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.asr.provider = 'webrtc';
      s.asr.signalingUrl = `http://127.0.0.1:${port}`;
      await window.studio.invoke('settings:save', s);
    }, rtcServer.address().port);
    await page.reload();
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    await page.locator('#audio-device').selectOption('mic:');
    await page.locator('[data-action="new-meeting"]').first().click();
    await page.locator('#name-input').fill('WebRTC 辨識測試');
    await page.locator('#name-confirm').click();
    await page.getByText('WebRTC 串流已完成驗證。', { exact: true }).waitFor();
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    await page.evaluate(() => window.rtcTestPeer?.close());
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('[data-theme-option="light"]').click();
    await page.locator('[data-action="save-settings"]').click();
    await page.locator('[data-action="back-workspace"]').click();
    await page.locator('.sidebar [data-project]').first().click();
    await page.screenshot({ path: 'output/playwright/overview-populated.png' });
    const journal = (
      await fs.readFile(path.join(profile, 'conversations', `${recorded.id}.jsonl`), 'utf8')
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert(journal.some((r) => r.type === 'message' && r.data.text === '請整理紀錄'));
    assert(journal.some((r) => r.type === 'run-event' && r.data.event.type === 'proposal'));
    await page.reload();
    await page.locator(`[data-meeting="${recorded.id}"]`).first().click();
    await page.getByText('先前的修訂提案', { exact: false }).first().waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      'Electron smoke passed: project, editor autosave, preview, revisions, themes, missing credentials, recording/pause/resume/audio playback, WebSocket PCM, WebRTC signaling/data channel, agent proposal/conflicts, native DOCX export.'
    );
    console.log('Screenshots: output/playwright/overview.png, workspace.png, workspace-dark.png');
  } finally {
    await app.close();
    modelServer.closeAllConnections();
    await new Promise((r) => modelServer.close(r));
    await new Promise((r) => asrServer.close(r));
    if (rtcServer) {
      rtcServer.closeAllConnections();
      await new Promise((r) => rtcServer.close(r));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
