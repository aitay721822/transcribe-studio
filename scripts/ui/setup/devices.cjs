const { _electron } = require('playwright');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

async function main() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.append')
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'model-test',
            transcript: '型號與指定裝置測試成功',
          })
        );
    })
  );
  const env = {
    ...process.env,
    STUDIO_TEST_DATA: await fs.mkdtemp(path.join(os.tmpdir(), 'studio-device-models-')),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  const rode = '麥克風 (RØDE NT-USB Mini)',
    bluetooth = 'Headset Microphone (Sony WH-1000XM5 Hands-Free AG Audio)';
  try {
    await require('./helpers.cjs').desktopWindow(app);
    const page = await app.firstWindow(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('.setup-page').waitFor();
    await page.evaluate(
      ({ rode, bluetooth }) => {
        window.devicesPermission = true;
        window.deviceStreams = [];
        window.deviceConstraints = [];

        const input = (deviceId, label, groupId) => ({
          deviceId,
          label,
          groupId,
          kind: 'audioinput',
        });

        window.deviceFixtures = [
          input('default', `Default - ${rode}`, 'usb'),
          input('communications', `Communications - ${bluetooth}`, 'bt'),
          input('rode', rode, 'usb'),
          input('sony', bluetooth, 'bt'),
          input('generic-a', 'USB Audio Device', 'a'),
          input('generic-b', 'USB Audio Device', 'b'),
        ];
        navigator.mediaDevices.enumerateDevices = async () =>
          window.deviceFixtures.map((d) => ({
            ...d,
            label: window.deviceStreams.some((s) =>
              s.getTracks().some((t) => t.readyState === 'live')
            )
              ? d.label
              : '',
          }));
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (!window.devicesPermission) throw new DOMException('denied', 'NotAllowedError');
          window.deviceConstraints.push(constraints);
          const context = new AudioContext(),
            oscillator = context.createOscillator(),
            destination = context.createMediaStreamDestination();
          oscillator.connect(destination);
          oscillator.start();
          await context.resume();
          const stream = destination.stream,
            track = stream.getAudioTracks()[0],
            stop = track.stop.bind(track),
            settings = track.getSettings.bind(track);
          const requested = constraints.audio.deviceId?.exact || 'rode',
            fixture = window.deviceFixtures.find((d) => d.deviceId === requested);
          Object.defineProperty(track, 'label', { value: fixture?.label || rode });
          track.getSettings = () => ({ ...settings(), deviceId: requested });
          track.stop = () => {
            stop();
            if (context.state !== 'closed') void context.close();
          };
          window.deviceStreams.push(stream);
          return stream;
        };
      },
      { rode, bluetooth }
    );
    await page.getByRole('tab', { name: '即時辨識（選用）' }).click();
    await page.locator('#setup-asr-url').fill(`ws://127.0.0.1:${server.address().port}`);
    await page.locator('#setup-test-realtime').click();
    await page.waitForFunction(
      () => document.querySelector('#connection-device')?.disabled === false
    );
    const values = await page
      .locator('#connection-device option')
      .evaluateAll((options) => options.map((o) => ({ value: o.value, label: o.textContent })));
    assert(values.some((o) => o.value === 'mic:' && o.label.includes(rode)));
    assert(values.some((o) => o.value === 'mic:communications' && o.label.includes(bluetooth)));
    assert.equal(values.filter((o) => o.label === 'USB Audio Device（同名裝置 1）').length, 1);
    assert.equal(values.filter((o) => o.label === 'USB Audio Device（同名裝置 2）').length, 1);
    assert(
      await page.evaluate(() =>
        window.deviceStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))
      )
    );
    await page.getByRole('combobox', { name: /^麥克風/ }).click();
    await page.getByRole('searchbox', { name: '搜尋麥克風' }).fill('WH-1000XM5');
    assert(await page.getByRole('option', { name: bluetooth, exact: true }).isVisible());
    assert(
      await page
        .getByRole('option', { name: bluetooth, exact: true })
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1)
    );
    await page.getByRole('option', { name: bluetooth, exact: true }).click();
    await page.locator('#connection-start').click();
    await page.locator('.connection-transcript .final').waitFor();
    assert.equal(
      await page.evaluate(() => window.deviceConstraints.at(-1).audio.deviceId.exact),
      'sony'
    );
    await page.getByRole('region', { name: '測試辨識文字' }).waitFor();
    assert.match(await page.locator('.device-details').textContent(), /WH-1000XM5/);
    assert.match(await page.locator('.device-details').textContent(), /裝置取樣率/);
    await page.locator('#connection-stop').click();
    await page.locator('#connection-start').waitFor();
    await page.locator('#connection-device').selectOption('mic:rode');
    await page.evaluate(() => {
      window.deviceFixtures = window.deviceFixtures.filter((d) => d.deviceId !== 'rode');
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
    await page.waitForFunction(
      () => document.querySelector('#connection-device')?.value === 'mic:'
    );
    await page.evaluate(() => {
      window.devicesPermission = false;
    });
    await page.getByRole('button', { name: '偵測完整裝置名稱', exact: true }).click();
    await page
      .getByText('麥克風權限未開啟，請至系統設定允許此應用程式存取麥克風後重新偵測。', {
        exact: true,
      })
      .waitFor();
    await page.evaluate(() => {
      window.devicesPermission = true;
    });
    await page.getByRole('button', { name: '偵測完整裝置名稱', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('#connection-device')?.disabled === false
    );
    await page.locator('[data-close-modal]').click();
    await require('./helpers.cjs').overview(page);
    await page.evaluate(async () => {
      await window.studio.invoke('project:create', '裝置型號');
    });
    await page.reload();
    await require('./helpers.cjs').overview(page);
    // Media mocks are renderer-scoped, so install a named device fixture again for the live view.
    await page.evaluate(() => {
      window.liveDeviceFixture = [
        {
          kind: 'audioinput',
          deviceId: 'default',
          groupId: 'usb',
          label: 'Default - 麥克風 (RØDE NT-USB Mini)',
        },
        {
          kind: 'audioinput',
          deviceId: 'rode',
          groupId: 'usb',
          label: '麥克風 (RØDE NT-USB Mini)',
        },
      ];
      navigator.mediaDevices.enumerateDevices = async () => window.liveDeviceFixture;
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext(),
          destination = context.createMediaStreamDestination();
        const track = destination.stream.getAudioTracks()[0],
          stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          void context.close();
        };
        return destination.stream;
      };
    });
    if (!(await page.locator('.sidebar [data-project]').first().isVisible()))
      await page.locator('[data-action="collapse-sidebar"]').click();
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    await page.waitForFunction(() => document.querySelector('#audio-device')?.disabled === false);
    await page.locator('#audio-device').selectOption('mic:rode');
    assert.match(await page.locator('.device-details').textContent(), /RØDE NT-USB Mini/);
    await page.getByRole('combobox', { name: /^麥克風/ }).click();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/device-models.png' });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 480, height: 820 });
    await page.getByRole('combobox', { name: /^麥克風/ }).click();
    assert(await page.getByRole('option', { name: rode, exact: true }).isVisible());
    assert(
      await page.locator('.device-options').evaluate((e) => {
        const rect = e.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && e.scrollWidth <= e.clientWidth + 1;
      })
    );
    assert(
      await page
        .locator('.device-details strong, .device-details p')
        .evaluateAll((elements) =>
          elements.every((e) => Number.parseFloat(getComputedStyle(e).fontSize) >= 16)
        )
    );
    assert.deepEqual(errors, []);
    console.log(
      'Device model UI passed: live permission labels, default/communications routes, duplicate names, model search/wrapping, exact device capture, stream metadata, unplug fallback, denied/retry and shared live picker.'
    );
  } finally {
    await app.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((r) => server.close(r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
