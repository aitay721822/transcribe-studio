const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
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

test('Mac bundle verification passes file paths before lipo architecture flags and preserves diagnostics', async (t) => {
  const verifyMacBundle = require('../../scripts/build/mac.cjs');

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'studio-mac-bundle-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('studio-mac-bundle-'));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const dependencies = path.join(
    root,
    'Transcribe Studio.app/Contents/Resources/app.asar.unpacked/node_modules'
  );
  const binaries = [
    path.join(dependencies, 'ffmpeg-static/ffmpeg'),
    path.join(dependencies, '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
  ];
  for (const binary of binaries) {
    await fs.promises.mkdir(path.dirname(binary), { recursive: true });
    await fs.promises.writeFile(binary, 'fixture');
  }
  const context = {
    electronPlatformName: 'darwin',
    arch: 3,
    appOutDir: root,
    packager: { appInfo: { productFilename: 'Transcribe Studio' } },
  };
  const checked = [];
  let status = 0;
  let error;
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, '/usr/bin/lipo');
    assert(binaries.includes(args[0]));
    assert.deepEqual(args.slice(1), ['-verify_arch', 'arm64']);
    assert.equal(options.windowsHide, true);
    checked.push(args[0]);
    return { status, stderr: status ? 'file does not contain arm64' : '', error };
  });
  await verifyMacBundle(context);
  assert.deepEqual(checked, binaries);
  status = 1;
  await assert.rejects(verifyMacBundle(context), /ffmpeg: file does not contain arm64/);
  status = null;
  error = new Error('spawn lipo ENOENT');
  await assert.rejects(verifyMacBundle(context), /ffmpeg: spawn lipo ENOENT/);
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
