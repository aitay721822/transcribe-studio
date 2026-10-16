const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

async function compileWindowsHost(root) {
  if (process.platform !== 'win32') return;
  const directory = path.join(root, 'dist/native');
  await fs.mkdir(directory, { recursive: true });
  const compiler = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  );
  const result = spawnSync(
    compiler,
    [
      '/nologo',
      '/optimize+',
      '/target:winexe',
      '/platform:anycpu',
      `/out:${path.join(directory, 'studio-cli-host.exe')}`,
      path.join(root, 'src/transport/runtime/hidden-host.cs'),
    ],
    { windowsHide: true, encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stdout || result.stderr || 'Windows CLI host build failed');
}

module.exports = { compileWindowsHost };
