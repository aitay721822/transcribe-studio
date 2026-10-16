const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const asar = require('@electron/asar');
const { packagedExecutable } = require('./executable.cjs');

async function main() {
  const executable = process.env.STUDIO_PACKAGED || packagedExecutable();
  const resources =
    process.platform === 'darwin'
      ? path.resolve(path.dirname(executable), '../Resources')
      : path.join(path.dirname(executable), 'resources');
  const archive = path.join(resources, 'app.asar');
  const files = asar.listPackage(archive).map((file) => file.replaceAll('\\', '/'));
  for (const name of ['@anthropic-ai', 'react', 'react-dom', 'motion', 'framer-motion', 'radix-ui'])
    assert(
      !files.some((file) => file.startsWith(`/node_modules/${name}/`)),
      `${name} must not be shipped`
    );
  await assert.rejects(
    fs.access(path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai')),
    { code: 'ENOENT' }
  );
  assert(files.some((file) => file.endsWith('/node_modules/ffmpeg-static/package.json')));
  const main = asar.extractFile(archive, 'dist/main.cjs').toString();
  assert(!main.includes('sourceMappingURL=data:'), 'Release must not contain inline source maps');
  console.log(
    `Package size audit passed: ${(await fs.stat(archive)).size} bytes ASAR; external Claude, bundled FFmpeg and no duplicate renderer packages.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
