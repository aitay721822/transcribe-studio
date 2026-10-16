const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { packageArguments, packageEnvironment } = require('../../scripts/build/targets.cjs');
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

test('unsigned Mac verification ignores empty and inherited signing credentials without mutating the caller', () => {
  for (const link of ['', '   ', 'fixture-certificate.p12']) {
    const source = {
      CSC_LINK: link,
      CSC_KEY_PASSWORD: 'secret',
      APPLE_ID: 'private',
      PATH: 'tools',
    };
    const env = packageEnvironment('darwin', false, source);
    assert.equal('CSC_LINK' in env, false);
    assert.equal('CSC_KEY_PASSWORD' in env, false);
    assert.equal('APPLE_ID' in env, false);
    assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.equal(env.PATH, 'tools');
    assert.equal(source.CSC_LINK, link);
    assert.equal(source.CSC_KEY_PASSWORD, 'secret');
  }
});

test('signed Mac releases validate missing secrets, preserve certificate passwords and require signing', () => {
  assert.throws(
    () => packageEnvironment('darwin', true, { CSC_LINK: ' ' }),
    /requires: CSC_LINK, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/
  );
  const source = {
    CSC_LINK: 'fixture-certificate.p12',
    CSC_KEY_PASSWORD: ' secret ',
    APPLE_ID: 'fixture-id',
    APPLE_APP_SPECIFIC_PASSWORD: 'fixture-password',
    APPLE_TEAM_ID: 'fixture-team',
  };
  const env = packageEnvironment('darwin', true, source);
  for (const name of Object.keys(source)) assert.equal(env[name], source[name]);
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'true');
  assert(
    packageArguments('mac', 'arm64', 'darwin', true).includes('--config.forceCodeSigning=true')
  );
  assert.throws(
    () => packageEnvironment('darwin', true, { ...source, APPLE_TEAM_ID: '' }),
    /requires: APPLE_TEAM_ID/
  );
});

test('Windows packaging retains its signing configuration and compression override', () => {
  const source = {
    CSC_LINK: 'windows.p12',
    CSC_KEY_PASSWORD: 'password',
    ELECTRON_BUILDER_COMPRESSION_LEVEL: '9',
  };
  assert.deepEqual(packageEnvironment('win32', false, source), source);
});

test('unsigned Mac CLI config bypasses certificate loading in the actual app and DMG signing paths', async (t) => {
  const {
    createYargs,
    configureBuildCommand,
    normalizeOptions,
  } = require('electron-builder/out/builder');
  const { MacPackager } = require('app-builder-lib/out/macPackager');
  const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper');
  const macCodeSign = require('app-builder-lib/out/codeSign/macCodeSign');
  const { DmgTarget } = require('dmg-builder');
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');

  const options = normalizeOptions(
    configureBuildCommand(createYargs())
      .exitProcess(false)
      .parse(packageArguments('mac', 'arm64', 'darwin'))
  );
  await validateConfiguration(options.config, { isEnabled: false });
  assert.equal(options.config.mac.identity, null);
  assert.equal(options.config.mac.notarize, false);
  assert.equal(options.config.dmg.sign, false);
  // Exercise macOS signing branches on every host, without invoking native commands.
  t.mock.method(macCodeSign, 'isSignAllowed', () => true);
  const packager = {
    platformSpecificBuildOptions: options.config.mac,
    forceCodeSigning: false,

    get codeSigningInfo() {
      assert.fail('Unsigned verification must not read or import a signing certificate');
    },
  };
  packager.helper = new MacTargetHelper(packager);
  assert.equal(await MacPackager.prototype.sign.call(packager, '/demo.app', '/output'), false);
  await DmgTarget.prototype.signDmg.call({ packager }, '/demo.dmg');
  const signed = normalizeOptions(
    configureBuildCommand(createYargs())
      .exitProcess(false)
      .parse(packageArguments('mac', 'arm64', 'darwin', true))
  );
  assert.notEqual(signed.config.mac.identity, null);
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
