const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { build } = require('esbuild');

async function main() {
  if (process.platform !== 'win32') {
    console.log(
      'Native per-endpoint playback integration requires Windows; selection logic is covered by audio unit tests.'
    );
    return;
  }
  const env = {
    ...process.env,
    STUDIO_TEST_DATA: await fs.mkdtemp(path.join(os.tmpdir(), 'studio-playback-')),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    const page = await require('./helpers.cjs').desktopWindow(app);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await require('./helpers.cjs').overview(page);
    await page.evaluate(async () => window.studio.invoke('project:create', '獨立音訊裝置'));
    await page.reload();
    await require('./helpers.cjs').overview(page);
    await page.evaluate(async () => {
      window.realOutputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === 'audiooutput'
      );
      navigator.mediaDevices.enumerateDevices = async () => [
        {
          kind: 'audioinput',
          deviceId: 'default',
          label: 'Default - USB Microphone',
          groupId: 'usb',
        },
        { kind: 'audioinput', deviceId: 'usb', label: 'USB Microphone', groupId: 'usb' },
      ];
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        window.lastMicrophone = constraints.audio?.deviceId?.exact || '';
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        await context.resume();
        const track = destination.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => {
          if (stopped) return;
          stopped = true;
          stop();
          void context.close();
        };
        return destination.stream;
      };
    });
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    const microphone = page.locator('#audio-device');
    const playback = page.locator('#audio-device-playback');
    await page.waitForFunction(() => !document.querySelector('#audio-device-playback')?.disabled);
    assert.equal(await microphone.inputValue(), 'mic:');
    assert.equal(await playback.inputValue(), 'none');
    const outputs = await page.evaluate(() => window.studio.invoke('media:playback-devices'));
    assert(outputs.length > 0, 'Windows integration requires a connected playback endpoint');
    for (const device of outputs)
      assert.equal(
        (await playback.locator('option').filter({ hasText: device.label }).count()) >= 1,
        true
      );
    await microphone.selectOption('none');
    await page.locator('[data-action="new-meeting"]').click();
    await page.getByText('請至少選擇一個播放裝置或麥克風', { exact: true }).first().waitFor();
    assert.equal(
      await page.evaluate(async () => (await window.studio.invoke('bootstrap')).meetings.length),
      0
    );
    await playback.selectOption(outputs[0].id);
    assert.equal(await microphone.inputValue(), 'none');
    await microphone.selectOption('mic:usb');
    assert.equal(await playback.inputValue(), outputs[0].id);
    await page.locator('[data-action="test-asr-connection"]').click();
    await page.waitForFunction(
      () => !document.querySelector('#connection-device-playback')?.disabled
    );
    assert.equal(await page.locator('#connection-device-playback').inputValue(), outputs[0].id);
    assert.equal(await page.locator('#connection-device').inputValue(), 'mic:usb');
    await page.locator('#connection-device-playback').selectOption('none');
    await page.locator('#connection-device').selectOption('none');
    assert.equal(await page.locator('#connection-start').isDisabled(), true);
    await page.locator('[data-close-modal]').click();
    assert.equal(await playback.inputValue(), outputs[0].id);
    assert.equal(await microphone.inputValue(), 'mic:usb');

    const bundle = await build({
      entryPoints: ['src/ui/audio/sources.ts'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'AudioHarness',
    });
    await page.evaluate(`${bundle.outputFiles[0].text}\nglobalThis.AudioHarness = AudioHarness;`);
    const result = await page.evaluate(async (devices) => {
      const captured = [];
      for (const device of devices) {
        let nativePeak = 0;
        let packets = 0;
        const unsubscribe = window.studio.on('media:playback', (event) => {
          if (event.type !== 'audio') return;
          packets++;
          const samples = new Float32Array(new Uint8Array(event.samples).buffer);
          for (const sample of samples) nativePeak = Math.max(nativePeak, Math.abs(sample));
        });
        const stream = (await window.AudioHarness.openAudioSources('system', '', device.id))[0];
        const track = stream.getAudioTracks()[0];
        if (track.readyState !== 'live') throw new Error('Native loopback track is not live');
        // A quiet test tone is routed to the matching physical endpoint, including a non-default one.
        const output = window.realOutputs.find(
          (item) => item.deviceId !== 'default' && item.label === device.label
        );
        if (output && !device.muted && device.volume > 0) {
          const render = new AudioContext();
          const oscillator = render.createOscillator();
          const volume = render.createGain();
          const destination = render.createMediaStreamDestination();
          volume.gain.value = 0.02;
          oscillator.connect(volume).connect(destination);
          oscillator.start();
          await render.resume();
          const tone = new Audio();
          tone.srcObject = destination.stream;
          await tone.setSinkId(output.deviceId);
          await tone.play();
          const analysis = new AudioContext();
          const analyser = analysis.createAnalyser();
          analysis.createMediaStreamSource(stream).connect(analyser);
          await analysis.resume();
          const samples = new Float32Array(analyser.fftSize);
          const deadline = performance.now() + 5000;
          let peak = 0;
          while (performance.now() < deadline && peak < 0.000001) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            analyser.getFloatTimeDomainData(samples);
            peak = Math.max(...samples.map(Math.abs));
          }
          tone.pause();
          tone.srcObject = null;
          await render.close();
          await analysis.close();
          if (peak < 0.000001)
            throw new Error(
              `No audio captured from ${device.label}: nativePeak=${nativePeak}, packets=${packets}, sink=${tone.sinkId}, requested=${output.deviceId}`
            );
          captured.push(device.label);
        }
        track.stop();
        unsubscribe();
        if (track.readyState !== 'ended') throw new Error('Native loopback was not stopped');
        await window.studio.invoke('media:playback-stop', 'unused');
      }
      const streams = await window.AudioHarness.openAudioSources('both', 'usb', devices[0].id);
      if (streams.length !== 2 || window.lastMicrophone !== 'usb')
        throw new Error('Mixed selection lost a device');
      streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      return captured;
    }, outputs);
    assert.equal(
      result.length,
      outputs.filter((device) => !device.muted && device.volume > 0).length,
      'Every audible endpoint must carry a real tone; muted endpoints still verify capture/cleanup without changing system volume'
    );
    await page.locator('[data-action="test-audio"]').click();
    await page.getByText('來源已連接，播放聲音或說話以確認音量。', { exact: true }).waitFor();
    await page.locator('[data-close-modal]').click();
    await page.locator('#record-only').check();
    await page.locator('[data-action="new-meeting"]').click();
    await page.locator('#name-input').fill('指定播放裝置與麥克風錄音');
    await page.locator('#name-confirm').click();
    await page.locator('[data-action="stop-recording"]').waitFor();
    await page.waitForFunction(() => {
      const timer = document.querySelector('#record-timer')?.textContent;
      return timer && timer.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) >= 1;
    });
    await page.locator('[data-action="stop-recording"]').click();
    await page.getByText('錄音已儲存', { exact: true }).waitFor();
    const recording = await page.evaluate(
      async () => (await window.studio.invoke('bootstrap')).meetings[0]
    );
    assert(recording.recordings[0].bytes > 0);
    assert(recording.duration >= 1);
    assert.equal(await page.evaluate(() => window.lastMicrophone), 'usb');
    await page.locator('.sidebar [data-project]').first().click();
    await page.locator('[data-action="project-live"]').click();
    await page.waitForFunction(() => !document.querySelector('#audio-device-playback')?.disabled);
    assert.equal(await playback.inputValue(), outputs[0].id);
    assert.equal(await microphone.inputValue(), 'mic:usb');
    await assert.rejects(
      page.evaluate(() =>
        window.studio.invoke('media:playback-start', 'offline', 'missing-endpoint')
      ),
      /離線/
    );
    await page.evaluate(async (device) => {
      await window.studio.invoke('media:playback-start', 'reload-fixture', device);
      try {
        await window.studio.invoke('media:playback-start', 'duplicate', device);
        throw new Error('Concurrent playback capture was allowed');
      } catch (error) {
        if (!error.message.includes('正在擷取')) throw error;
      }
    }, outputs[0].id);
    await page.setViewportSize({ width: 480, height: 820 });
    for (const name of ['播放裝置', '麥克風']) {
      const box = await page.getByRole('combobox', { name: new RegExp(`^${name}`) }).boundingBox();
      assert(box.x >= 0 && box.x + box.width <= 480);
    }
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/independent-audio-devices.png' });
    await page.reload();
    await page.locator('.shell').waitFor();
    await page.evaluate(async (device) => {
      await window.studio.invoke('media:playback-start', 'after-reload', device);
      await window.studio.invoke('media:playback-stop', 'after-reload');
      if (localStorage.getItem('studio.playback') !== device)
        throw new Error('Playback selection was not persisted');
      if (localStorage.getItem('studio.source') !== 'both')
        throw new Error('Capture combination was not persisted');
    }, outputs[0].id);
    assert.deepEqual(errors, []);
    console.log(
      'Independent audio selectors passed: all four combinations, no empty meetings, test inheritance, native per-endpoint tone capture, mixing, cleanup and compact layout.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
