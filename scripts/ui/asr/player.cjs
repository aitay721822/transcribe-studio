const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

async function verifyPlayer(page, app) {
  const player = page.getByRole('group', { name: '錄音播放控制', exact: true });
  await page.waitForFunction(() => document.querySelector('audio[data-audio-id]')?.readyState >= 1);
  const audio = player.locator('audio');
  assert.equal(await audio.getAttribute('controls'), null);
  const timeline = player.getByRole('slider', { name: '錄音播放位置', exact: true });
  const length = Number(await timeline.getAttribute('aria-valuemax'));
  assert(length > 1);
  await player.getByRole('button', { name: '播放錄音', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  await player.getByRole('button', { name: '暫停錄音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('audio').paused);
  assert(
    await audio.evaluate(
      (element) =>
        element.seekable.length > 0 &&
        element.seekable.end(element.seekable.length - 1) >= element.duration
    )
  );
  await timeline.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('audio').currentTime >= 0.09);
  await page.keyboard.press('End');
  await page.waitForFunction(
    (value) => Math.abs(document.querySelector('audio').currentTime - value) < 0.1,
    length
  );
  assert(Math.abs((await audio.evaluate((element) => element.currentTime)) - length) < 0.1);
  await page.keyboard.press('Home');
  const track = player.locator('[data-slot="slider"]').first();
  const box = await track.boundingBox();
  await track.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForFunction(
    (value) => Math.abs(document.querySelector('audio').currentTime - value / 2) < 0.15,
    length
  );
  assert(Math.abs((await audio.evaluate((element) => element.currentTime)) - length / 2) < 0.15);
  const volume = player.getByRole('slider', { name: '錄音播放音量', exact: true });
  await volume.focus();
  await page.keyboard.press('Home');
  assert.equal(await audio.evaluate((element) => element.volume), 0);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await audio.evaluate((element) => element.volume), 0.99);
  await player.getByRole('button', { name: '靜音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('audio').muted);
  await player.getByRole('button', { name: '取消靜音', exact: true }).click();
  assert.equal(await audio.evaluate((element) => element.muted), false);
  assert.equal(await audio.evaluate((element) => element.volume), 0.99);
  await player.getByRole('combobox', { name: /^播放速度/ }).click();
  await page.getByRole('option', { name: '1.5×', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('audio').playbackRate === 1.5);
  await audio.evaluate((element) => {
    element.currentTime = 0.5;
    element.dispatchEvent(new Event('timeupdate'));
    element.volume = 0.42;
    element.playbackRate = 2;
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="錄音播放音量"]')?.getAttribute('aria-valuenow') === '42'
  );
  assert.equal(Number(await timeline.getAttribute('aria-valuenow')), 0.5);
  assert.equal(await player.locator('select').inputValue(), '2');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await fs.mkdir('output/playwright', { recursive: true });
  for (const value of ['light', 'dark', 'forest']) {
    await page.evaluate((next) => {
      document.documentElement.dataset.theme = next;
    }, value);
    await player.screenshot({ path: `output/playwright/recording-player-${value}.png` });
  }
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await require('../setup/helpers.cjs').resizeWindow(app, page, 480, 820);
  await player.scrollIntoViewIfNeeded();
  assert(await player.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
  await player.screenshot({ path: 'output/playwright/recording-player-narrow.png' });
  await require('../setup/helpers.cjs').resizeWindow(app, page, size.width, size.height);
  const src = await audio.getAttribute('src');
  await audio.evaluate((element) => {
    element.src = 'data:audio/wav;base64,AAAA';
    element.load();
  });
  await player.getByRole('alert').waitFor();
  assert.equal(await player.getByRole('button', { name: '播放錄音' }).isDisabled(), true);
  assert.notEqual(await timeline.getAttribute('data-disabled'), null);
  await audio.evaluate((element, source) => {
    element.src = source;
    element.load();
  }, src);
  await page.waitForFunction(() => document.querySelector('audio').readyState >= 1);
  await player.getByRole('alert').waitFor({ state: 'detached' });
  assert.equal(await player.getByRole('button', { name: '播放錄音' }).isEnabled(), true);
}

module.exports = { verifyPlayer };
