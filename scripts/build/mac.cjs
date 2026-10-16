const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Fail before distribution if an app contains a foreign FFmpeg or Claude binary. */
module.exports = async function verifyMacBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = context.arch === 3 ? 'arm64' : 'x86_64';
  const resources = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents/Resources'
  );
  const dependencies = path.join(resources, 'app.asar.unpacked/node_modules');
  const binaries = [
    path.join(dependencies, 'ffmpeg-static/ffmpeg'),
    path.join(
      dependencies,
      `@anthropic-ai/claude-agent-sdk-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}/claude`
    ),
  ];
  for (const binary of binaries) {
    await fs.access(binary);
    await fs.chmod(binary, 0o755);
    const result = spawnSync('/usr/bin/lipo', ['-verify_arch', arch, binary], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error(`Incorrect macOS binary architecture: ${path.basename(binary)}`);
  }
};
