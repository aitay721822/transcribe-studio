const { test } = require('node:test');
const assert = require('node:assert/strict'),
  path = require('node:path'),
  vm = require('node:vm');
const { inputDeviceCatalog } = require('../../dist/domain/audio-devices.cjs');

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

async function sources(mediaDevices) {
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
