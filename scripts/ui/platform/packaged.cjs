const { spawnSync } = require('node:child_process');
const { packagedExecutable } = require('./executable.cjs');

for (const script of [
  'scripts/ui/platform/desktop.cjs',
  'scripts/ui/security/credentials.cjs',
  'scripts/ui/harness-packaged.cjs',
]) {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, STUDIO_PACKAGED: process.env.STUDIO_PACKAGED || packagedExecutable() },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
