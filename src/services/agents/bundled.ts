import fs from 'node:fs/promises';

export function bundledClaudeModule(platform: string, arch: string) {
  if (
    !['win32', 'darwin', 'linux'].includes(platform) ||
    !['x64', 'arm64'].includes(arch) ||
    (platform === 'darwin' && arch !== 'arm64')
  )
    throw new Error('此平台沒有隨附 Claude runtime，請指定本機 CLI 路徑');
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${platform === 'win32' ? '.exe' : ''}`;
}

export async function bundledClaude(platform = process.platform, arch = process.arch) {
  const file = require
    .resolve(bundledClaudeModule(platform, arch))
    .replace(/\.asar([\\/])/g, '.asar.unpacked$1');
  await fs.access(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  return file;
}
