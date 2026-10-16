const { _electron } = require('playwright');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const { WebSocketServer } = require('ws');

async function main() {
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => ws.once('listening', r));
  let pcm = 0,
    nonzero = false,
    agentRequests = 0;
  ws.on('connection', (socket) =>
    socket.on('message', (data, binary) => {
      if (binary) {
        pcm += data.length;
        for (let i = 0; i < data.length; i += 2) if (data.readInt16LE(i)) nonzero = true;
        if (pcm > 4800)
          socket.send(JSON.stringify({ id: 'speech', text: '今天要確認會議決議。', final: true }));
      } else {
        const event = JSON.parse(data.toString());
        if (event.type === 'session.update')
          socket.send(JSON.stringify({ type: 'session.updated' }));
        if (event.type === 'input_audio_buffer.append') {
          const bytes = Buffer.from(event.audio, 'base64');
          pcm += bytes.length;
          for (let i = 0; i < bytes.length; i += 2) if (bytes.readInt16LE(i)) nonzero = true;
          if (pcm > 4800)
            socket.send(
              JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: 'speech',
                transcript: '今天要確認會議決議。',
              })
            );
        }
        if (event.type === 'input_audio_buffer.commit')
          socket.send(
            JSON.stringify({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: 'openai-speech',
              transcript: 'OpenAI 串流辨識測試文字。',
            })
          );
      }
    })
  );
  const model = http.createServer(async (req, res) => {
    if (req.url.includes('slow')) return;
    if (req.url.includes('deny')) {
      res.writeHead(401);
      return res.end('not authorized');
    }
    for await (const _ of req) {
    }
    agentRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '連線測試成功' }],
          },
        ],
      })
    );
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-connections-')),
    env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    await require('./helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('.setup-page').waitFor();
    await page.evaluate(() => {
      window.connectionStreams = [];
      window.connectionConstraints = [];
      navigator.mediaDevices.enumerateDevices = async () => [
        { kind: 'audioinput', deviceId: 'test-microphone', label: '測試指定麥克風' },
      ];
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        window.connectionConstraints.push(constraints);
        const context = new AudioContext(),
          oscillator = context.createOscillator(),
          gain = context.createGain(),
          destination = context.createMediaStreamDestination();
        gain.gain.value = 0.15;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await context.resume();
        const stream = destination.stream,
          track = stream.getAudioTracks()[0],
          stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          if (context.state !== 'closed') void context.close();
        };
        window.connectionStreams.push(stream);
        return stream;
      };
    });
    const url = `ws://127.0.0.1:${ws.address().port}`;
    await page.getByRole('tab', { name: '即時辨識（選用）' }).click();
    await page.locator('#setup-asr-url').fill(url);
    await page.locator('#setup-asr-model').fill('local-model');
    await page.locator('#setup-test-realtime').click();
    await page.locator('#connection-device').selectOption('mic:test-microphone');
    await page.locator('#connection-start').click();
    await page
      .locator('.connection-transcript .final')
      .filter({ hasText: '今天要確認會議決議。' })
      .waitFor();
    assert(pcm > 4800 && nonzero, 'real browser capture must reach ASR as non-silent PCM');
    assert(
      await page.evaluate(() =>
        window.connectionConstraints.some((c) => c.audio.deviceId?.exact === 'test-microphone')
      )
    );
    assert.equal(
      (await page.evaluate(() => window.studio.invoke('bootstrap'))).settings.asr.provider,
      'transcriptions',
      'testing must not save drafts'
    );
    await page.locator('#connection-stop').click();
    await page.locator('#connection-start').waitFor();
    assert(
      await page.evaluate(() =>
        window.connectionStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))
      )
    );
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/speech-connection-test.png' });
    await page.locator('#connection-start').click();
    await page.waitForFunction(() =>
      document.querySelector('#connection-status').textContent.includes('已連線')
    );
    await page.locator('[data-close-modal]').click();
    await page.waitForFunction(() =>
      window.connectionStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))
    );
    await page.getByRole('tab', { name: '離線辨識（必填）' }).click();
    await page.locator('#setup-asr-file-url').fill('http://127.0.0.1:1/v1/audio/transcriptions');
    await page.locator('#setup-next').click();
    await page.locator('#setup-llm-url').fill(`http://127.0.0.1:${model.address().port}/v1`);
    await page.locator('#setup-llm-key').fill('draft-model-key');
    await page.locator('#setup-llm-model').fill('local-test');
    await page.locator('#setup-test').click();
    await page.locator('#agent-connection-start').click();
    await page.locator('#agent-connection-reply').filter({ hasText: '連線測試成功' }).waitFor();
    assert.equal(agentRequests, 1);
    assert.equal(
      (await page.evaluate(() => window.studio.invoke('bootstrap'))).settings.llm.apiKey,
      ''
    );
    await page.locator('[data-close-modal]').click();
    await page.locator('#setup-next').click();
    await page.locator('#setup-next').click();
    if (!(await page.locator('[data-view="settings"]').isVisible()))
      await page.locator('[data-action="collapse-sidebar"]').click();
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    assert.equal(await page.locator('#llm-key').inputValue(), '••••••••');
    await page.locator('[data-action="test-agent-connection"]').click();
    await page.locator('#agent-connection-start').click();
    await page.locator('#agent-connection-reply').waitFor();
    await page.locator('[data-close-modal]').click();
    await page.locator('#llm-url').fill(`http://127.0.0.1:${model.address().port}/deny`);
    await page.locator('[data-action="test-agent-connection"]').click();
    await page.locator('#agent-connection-start').click();
    await page.locator('#agent-connection-error').filter({ hasText: '401' }).waitFor();
    await page.locator('[data-close-modal]').click();
    await page.locator('#llm-url').fill(`http://127.0.0.1:${model.address().port}/slow`);
    await page.locator('[data-action="test-agent-connection"]').click();
    await page.locator('#agent-connection-start').click();
    await page.getByRole('button', { name: '取消測試', exact: true }).click();
    await page.locator('#agent-connection-error').filter({ hasText: '取消' }).waitFor();
    await page.locator('[data-close-modal]').click();
    await page.locator('[data-settings-tab="asr"]').click();
    await page.getByRole('tab', { name: '即時辨識（選用）' }).click();
    await page.locator('#asr-url').fill(url);
    await page.locator('#asr-key').fill('draft-asr-key');
    pcm = 0;
    await page.locator('[data-action="test-realtime-connection"]').click();
    await page.locator('#connection-start').click();
    await page.waitForFunction(() =>
      document.querySelector('#connection-status').textContent.includes('已連線')
    );
    await page.waitForFunction(
      () =>
        parseFloat(
          document
            .querySelector('.connection-level > div')
            .style.transform.match(/scaleX\(([^)]+)/)?.[1]
        ) > 0
    );
    for (let i = 0; i < 100 && pcm < 4800; i++) await new Promise((r) => setTimeout(r, 10));
    assert(pcm >= 4800);
    await page.locator('#connection-stop').click();
    await page
      .locator('.connection-transcript .final')
      .filter({ hasText: 'OpenAI 串流辨識測試文字。' })
      .waitFor();
    await page.locator('#connection-start').waitFor();
    await page.locator('[data-close-modal]').click();
    await page.getByRole('tab', { name: '即時辨識（選用）' }).click();
    await page.locator('#asr-url').fill('ws://127.0.0.1:1');
    await page.locator('[data-action="test-realtime-connection"]').click();
    await page.locator('#connection-start').click();
    await page
      .locator('#connection-error')
      .filter({ hasText: /ECONNREFUSED|中斷/ })
      .waitFor();
    await page.waitForFunction(() =>
      window.connectionStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))
    );
    await page.locator('[data-close-modal]').click();
    const bootstrap = await page.evaluate(() => window.studio.invoke('bootstrap'));
    assert.equal(bootstrap.meetings.length, 0);
    assert.equal(bootstrap.projects.length, 0);
    const audio = await fs.readdir(path.join(profile, 'audio'));
    assert.deepEqual(audio, []);
    assert.deepEqual(errors, []);
    console.log(
      'Connection UI passed: setup/settings draft tests, selected device PCM, OpenAI-compatible Realtime recognition, final drain, real model request, masked keys, auth/network errors, cancellation and cleanup without meeting/audio persistence.'
    );
  } finally {
    await app.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise((r) => ws.close(r));
    model.closeAllConnections();
    await new Promise((r) => model.close(r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
