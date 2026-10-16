const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');

/** Fail before distribution if the app contains a foreign FFmpeg binary. */
module.exports = async function verifyMacBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (context.arch !== 3) throw new Error('macOS packages only support Apple Silicon (arm64)');
  const arch = 'arm64';
  const resources = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents/Resources'
  );
  const dependencies = path.join(resources, 'app.asar.unpacked/node_modules');
  const binaries = [path.join(dependencies, 'ffmpeg-static/ffmpeg')];
  for (const binary of binaries) {
    await fs.access(binary);
    await fs.chmod(binary, 0o755);
    // lipo treats every argument after -verify_arch as an architecture name.
    const result = childProcess.spawnSync('/usr/bin/lipo', [binary, '-verify_arch', arch], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const detail =
        result.error?.message ||
        result.stderr?.trim() ||
        `lipo exited with status ${result.status}`;
      throw new Error(`Incorrect macOS binary architecture: ${path.basename(binary)}: ${detail}`);
    }
  }
};
