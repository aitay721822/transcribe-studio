const { spawnSync } = require('node:child_process');
const { packageArguments, packageEnvironment } = require('./targets.cjs');

const release = process.env.STUDIO_MAC_RELEASE === '1';
const args = packageArguments(process.argv[2], process.argv[3], process.platform, release);
if (args.includes('--mac'))
  console.log(
    `macOS arm64 packaging: ${release ? 'signed release' : 'verification, identity=null, certificate import disabled'}`
  );
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], {
  stdio: 'inherit',
  windowsHide: true,
  env: packageEnvironment(process.platform, release),
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
