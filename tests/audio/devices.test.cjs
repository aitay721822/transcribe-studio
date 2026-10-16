const { test } = require('node:test');
const assert = require('node:assert/strict'),
  path = require('node:path'),
  vm = require('node:vm');
const { inputDeviceCatalog, selectedSource } = require('../../dist/domain/audio-devices.cjs');

const raw = (id, label, groupId = '') => ({ kind: 'audioinput', deviceId: id, label, groupId });

test('device catalog preserves model names, groups OS routes, distinguishes identical names and removes exact duplicates', () => {
  const name = '麥克風 (RØDE NT-USB Mini)',
    devices = inputDeviceCatalog([
      raw('default', 'Default - unknown', 'usb'),
      raw('communications', 'Communications - unknown', 'bt'),
      raw('usb-mic', name, 'usb'),
      raw('bluetooth', 'Headset Microphone (WH-1000XM5)', 'bt'),
      raw('same-a', 'USB Audio Device', 'a'),
      raw('same-b', 'USB Audio Device', 'b'),
      raw('same-a', 'USB Audio Device', 'a'),
      { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker', groupId: 'usb' },
    ]);
  assert.equal(devices[0].label, `系統預設 · ${name}`);
  assert.equal(devices.find((d) => d.id === 'usb-mic').name, name);
  assert.equal(devices.find((d) => d.id === 'usb-mic').isDefault, true);
  assert.equal(devices.find((d) => d.id === 'bluetooth').isCommunications, true);
  assert.equal(devices.at(-1).label, '通訊預設 · Headset Microphone (WH-1000XM5)');
  assert.deepEqual(
    devices.filter((d) => d.id.startsWith('same')).map((d) => d.label),
    ['USB Audio Device（同名裝置 1）', 'USB Audio Device（同名裝置 2）']
  );
  assert.equal(
    devices.some((d) => d.id === 'speaker'),
    false
  );
  assert.equal(inputDeviceCatalog([raw('anonymous', '')])[1].named, false);
});

async function sources(mediaDevices, invoke = async () => {}) {
  const { build } = require('esbuild');

  const result = await build({
    entryPoints: [path.join(__dirname, '../../src/ui/audio/sources.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module,
    exports: module.exports,
    navigator: { mediaDevices },
    window: { studio: { invoke } },
  });
  return module.exports;
}

test('device discovery reads model labels while permission stream is still live and always stops it', async () => {
  let active = false,
    stopped = 0;
  const track = {
    label: 'Default - Shure MV7',

    getSettings: () => ({ deviceId: 'shure' }),

    stop: () => {
      active = false;
      stopped++;
    },
  };
  const mediaDevices = {
    getUserMedia: async () => {
      active = true;
      return {
        getAudioTracks: () => [track],

        getTracks: () => [track],
      };
    },

    enumerateDevices: async () => [raw('shure', active ? 'Shure MV7' : '', 'shure-group')],
  };
  const { listInputDevices } = await sources(mediaDevices);
  const devices = await listInputDevices(true);
  assert.equal(devices.find((d) => d.id === 'shure').label, 'Shure MV7');
  assert.equal(devices[0].name, 'Shure MV7');
  assert.equal(active, false);
  assert.equal(stopped, 1);
  mediaDevices.enumerateDevices = async () => {
    throw new Error('enumeration failed');
  };
  await assert.rejects(listInputDevices(true), /enumeration failed/);
  assert.equal(active, false);
  assert.equal(stopped, 2);
  mediaDevices.getUserMedia = async () => {
    throw new Error('permission denied');
  };
  await assert.rejects(listInputDevices(true), /permission denied/);
  assert.equal(stopped, 2);
});

test('system capture rejects missing or ended audio and releases every acquired track', async () => {
  for (const audioState of ['missing', 'ended']) {
    const stopped = [];
    const video = { stop: () => stopped.push('video') };
    const audio = {
      readyState: 'ended',

      stop: () => stopped.push('audio'),
    };
    const tracks = audioState === 'missing' ? [video] : [video, audio];
    const { openAudioSources } = await sources({
      getDisplayMedia: async () => ({
        getTracks: () => tracks,

        getAudioTracks: () => tracks.filter((track) => track === audio),
      }),
    });
    await assert.rejects(openAudioSources('system'), /音訊/);
    assert.equal(stopped.length, tracks.length);
  }
});

test('permission preflight blocks capture; microphone denial releases an existing system stream', async () => {
  let opened = 0;
  let stopped = 0;
  const track = {
    readyState: 'live',

    stop: () => stopped++,
  };
  const devices = {
    getDisplayMedia: async () => {
      opened++;
      return {
        getAudioTracks: () => [track],

        getTracks: () => [track],
      };
    },

    getUserMedia: async () => {
      throw new Error('microphone denied');
    },
  };
  const denied = await sources(devices, async (channel, source) => {
    assert.equal(channel, 'media:prepare');
    assert.equal(source, 'both');
    throw new Error('OS permission denied');
  });
  await assert.rejects(denied.openAudioSources('both'), /OS permission denied/);
  assert.equal(opened, 0);
  const allowed = await sources(devices);
  await assert.rejects(allowed.openAudioSources('both'), /microphone denied/);
  assert.equal(opened, 1);
  assert.equal(stopped, 1);
});

test('independent device selections cover all combinations and no-capture never requests permission', async () => {
  assert.equal(selectedSource('none', 'none'), 'none');
  assert.equal(selectedSource('none', 'mic:usb'), 'mic');
  assert.equal(selectedSource('speaker', 'none'), 'system');
  assert.equal(selectedSource('speaker', 'mic:usb'), 'both');
  let permissions = 0;
  const { openAudioSources } = await sources({}, async () => permissions++);
  await assert.rejects(openAudioSources('none'), /至少選擇/);
  assert.equal(permissions, 0);
});

test('microphone-only capture uses the exact input and never opens a playback stream', async () => {
  const stream = { getTracks: () => [] };
  const { openAudioSources } = await sources({
    getDisplayMedia: () => assert.fail('playback must not be opened'),

    getUserMedia: async (constraints) => {
      assert.equal(constraints.audio.deviceId.exact, 'usb-microphone');
      return stream;
    },
  });
  const result = await openAudioSources('mic', 'usb-microphone', 'unused-speaker');
  assert.equal(result.length, 1);
  assert.equal(result[0], stream);
});
