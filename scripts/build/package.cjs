const { spawnSync } = require('node:child_process');
const { packageArguments } = require('./targets.cjs');

const args = packageArguments(
  process.argv[2],
  process.argv[3],
  process.platform,
  process.env.STUDIO_MAC_RELEASE === '1'
);
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '5',
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
