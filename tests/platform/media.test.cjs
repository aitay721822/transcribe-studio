const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaPermissions } = require('../../dist/services/platform/media.cjs');
const { AudioHealth } = require('../../dist/ui/audio/lifecycle/health.cjs');

function access(overrides = {}) {
  let requested = 0;
  const port = {
    platform: 'darwin',
    release: '23.2.0',

    status: () => 'granted',

    requestMicrophone: async () => {
      requested++;
      return true;
    },

    openSettings: async () => {},

    ...overrides,
  };
  return {
    service: mediaPermissions(port),

    requested: () => requested,
  };
}

test('Mac media capability is bounded by OS version and does not disable microphones', async () => {
  for (const [release, supported] of [
    ['22.6.0', false],
    ['23.1.0', false],
    ['23.2.0', true],
    ['24.0.0', true],
  ]) {
    const { service } = access({ release });
    assert.equal(service.status().systemAudio, supported);
    await service.prepare('mic');
    if (!supported) await assert.rejects(service.prepare('both'), /虛擬音訊/);
    else await service.prepare('system');
  }
  assert.equal(access({ platform: 'win32', release: '10.0' }).service.status().systemAudio, true);
  assert.equal(access({ platform: 'linux' }).service.status().systemAudio, false);
});

test('permission requests distinguish first consent, denied, restricted and screen-only recording', async () => {
  const first = access({ status: () => 'not-determined' });
  await first.service.prepare('mic');
  assert.equal(first.requested(), 1);
  await first.service.prepare('system');
  assert.equal(first.requested(), 1, 'system audio never asks for unrelated microphone access');
  const denied = access({
    status: () => 'not-determined',

    requestMicrophone: async () => false,
  });
  await assert.rejects(denied.service.prepare('mic'), /系統設定/);
  for (const status of ['denied', 'restricted']) {
    const current = access({ status: () => status });
    await assert.rejects(current.service.prepare('mic'), /權限|政策|系統設定/);
    await assert.rejects(current.service.prepare('system'), /權限|政策|系統設定/);
    assert.equal(current.requested(), 0, 'previous denial must not repeatedly prompt');
  }
  await assert.rejects(first.service.prepare('invalid'), /無效/);
});

test('quiet audio is warned once without stopping; audible playback does not trigger a silence warning', () => {
  const warnings = [];
  const health = new AudioHealth((message) => warnings.push(message));
  const now = Date.now();
  health.sample(0, false, now + 5000);
  assert.equal(warnings.length, 0);
  health.sample(0, false, now + 11000);
  health.sample(0, true, now + 12000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /可繼續錄音/);
  const audible = new AudioHealth(() => assert.fail('audible stream should not warn'));
  audible.sample(0.05, false, now + 100);
  audible.sample(0, false, now + 20000);
});
