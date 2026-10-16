const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { packageArguments } = require('../../scripts/build/targets.cjs');
const {
  actionShortcut,
  shortcutLabel,
} = require('../../dist/ui/application/platform/shortcuts.cjs');

test('macOS packaging requires Apple Silicon, a Mac host and release signing', () => {
  const args = packageArguments('mac', 'arm64', 'darwin', true);
  assert.ok(args.includes('--arm64'));
  assert.ok(args.includes('--config.forceCodeSigning=true'));
  assert.ok(args.includes('--config.mac.notarize=true'));
  assert.equal(args.includes('--win'), false);
  assert.ok(packageArguments('mac', undefined, 'darwin').includes('--arm64'));
  assert.throws(() => packageArguments('mac', 'x64', 'darwin'), /Apple Silicon/);
  assert.throws(() => packageArguments('mac', 'arm64', 'win32'), /built on a Mac/);
  assert.throws(() => packageArguments('mac', 'ia32', 'darwin'), /arm64 and x64/);
  assert.deepEqual(packageArguments('portable', 'x64', 'win32'), [
    '--win',
    'portable',
    '--x64',
    '--publish',
    'never',
  ]);
  const { build, scripts } = require('../../package.json');

  assert.equal(scripts['package:mac:x64'], undefined);
  for (const target of build.mac.target) assert.deepEqual(target.arch, ['arm64']);

  assert.ok(build.mac.extendInfo.NSMicrophoneUsageDescription);
  assert.ok(build.mac.extendInfo.NSAudioCaptureUsageDescription);
  assert.equal(build.mac.minimumSystemVersion, '13.0');
  assert.equal(build.mac.hardenedRuntime, true);
  assert.match(
    fs.readFileSync(build.mac.entitlements, 'utf8'),
    /com.apple.security.device.audio-input/
  );
});

test('Mac bundle verification rejects Intel and universal bundles before checking binaries', async () => {
  const verifyMacBundle = require('../../scripts/build/mac.cjs');

  for (const arch of [1, 4])
    await assert.rejects(
      verifyMacBundle({ electronPlatformName: 'darwin', arch }),
      /Apple Silicon/
    );
  await verifyMacBundle({ electronPlatformName: 'win32', arch: 1 });
});

test('native Mac icon contains valid 256, 512 and 1024 pixel PNG chunks', () => {
  const bytes = fs.readFileSync('config/branding/native/icon.icns');
  assert.equal(bytes.toString('ascii', 0, 4), 'icns');
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  const sizes = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= bytes.length);
    sizes.push(bytes.readUInt32BE(offset + 24));
    offset += length;
  }
  assert.deepEqual(sizes, [256, 512, 1024]);
});

test('Mac action shortcuts use Command Shift, respect IME and match physical keys', () => {
  const event = {
    key: 'M',
    code: 'KeyM',
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
  };
  assert.equal(actionShortcut(event, 'm', 'darwin'), true);
  assert.equal(actionShortcut({ ...event, isComposing: true }, 'm', 'darwin'), false);
  assert.equal(actionShortcut({ ...event, key: 'µ', altKey: true }, 'm', 'darwin'), false);
  assert.equal(
    actionShortcut(
      { ...event, metaKey: false, ctrlKey: true, shiftKey: false, altKey: true },
      'm',
      'win32'
    ),
    true
  );
  assert.equal(shortcutLabel('m', true, 'darwin'), '⌘⇧M');
  assert.equal(shortcutLabel('s', false, 'darwin'), '⌘S');
  assert.equal(shortcutLabel('m', true, 'win32'), 'Ctrl+Alt+M');
});
