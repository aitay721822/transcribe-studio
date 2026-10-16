import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function hiddenHost() {
  // Each esbuild entry may bundle this module at a different depth under dist/.
  for (let depth = 0; depth < 4; depth++) {
    const file = path
      .join(__dirname, ...Array(depth).fill('..'), 'native', 'studio-cli-host.exe')
      .replace(/\.asar([\\/])/g, '.asar.unpacked$1');
    if (existsSync(file)) return file;
  }
  throw new Error('缺少背景 CLI 啟動程式，請重新建置或安裝 Studio。');
}

/** A hidden console is inherited by CLI descendants; windowsHide alone isn't inherited. */
export function spawnHidden(file: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  const command = process.platform === 'win32' ? hiddenHost() : file;
  return spawn(command, process.platform === 'win32' ? [file, ...args] : args, {
    ...options,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
}
