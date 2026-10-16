const { spawnSync } = require('node:child_process');

const target = process.argv[2] || 'nsis';
if (!['nsis', 'portable'].includes(target)) throw new Error('Unsupported Windows package target');
const result = spawnSync(
  process.execPath,
  [require.resolve('electron-builder/cli.js'), '--win', target, '--x64', '--publish', 'never'],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '5',
    },
  }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
