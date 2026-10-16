import fs from 'node:fs/promises';
import path from 'node:path';

export interface LaunchCommand {
  executable: string;
  args: string[];
}

async function javascriptCommand(
  file: string,
  prefix = path.dirname(file)
): Promise<LaunchCommand> {
  if (process.platform !== 'win32' || !process.versions.electron)
    return { executable: process.execPath, args: [file] };
  // Electron is a GUI executable even in RUN_AS_NODE mode: it cannot inherit the
  // hidden console. npm CLIs already require Node; use its console executable.
  const directories = [prefix, path.dirname(file), ...(process.env.PATH || '').split(';')];
  for (const directory of directories) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), 'node.exe');
    try {
      if ((await fs.stat(candidate)).isFile()) return { executable: candidate, args: [file] };
    } catch {}
  }
  throw new Error('JavaScript CLI 需要 Node.js，請安裝 Node.js 或選擇原生 CLI 執行檔。');
}

/** Resolve standard npm shims to their package entry; never evaluate shell text. */
export async function launchCommand(file: string): Promise<LaunchCommand> {
  if (!/\.(cmd|bat|ps1)$/i.test(file)) {
    return /\.(m?js|cjs)$/i.test(file) ? javascriptCommand(file) : { executable: file, args: [] };
  }
  const packageName = path.basename(file).replace(/\.(cmd|bat|ps1)$/i, '');
  const packages: Record<string, string> = {
    codex: '@openai/codex',
    claude: '@anthropic-ai/claude-code',
  };
  if (!packages[packageName]) throw new Error('不支援的 CLI 啟動檔');
  const directory = path.join(path.dirname(file), 'node_modules', packages[packageName]);
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[packageName];
  if (typeof entry !== 'string') throw new Error('CLI 套件沒有可執行入口');
  const target = path.resolve(directory, entry);
  if (!target.startsWith(`${directory}${path.sep}`) || !(await fs.stat(target)).isFile())
    throw new Error('CLI 套件入口無效');
  return javascriptCommand(target, path.dirname(file));
}

export async function executableCandidates(
  id: 'codex' | 'claude',
  configured = '',
  env = process.env,
  platform = process.platform
): Promise<string[]> {
  if (configured) {
    try {
      return (await fs.stat(configured)).isFile() ? [path.resolve(configured)] : [];
    } catch {
      return [];
    }
  }
  const extensions =
    platform === 'win32'
      ? [...new Set((env.PATHEXT || '.EXE;.CMD;.BAT').toLowerCase().split(';').filter(Boolean))]
      : [''];
  const dirs = (env.PATH || '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .map((dir) => dir.replace(/^"|"$/g, ''));
  const home = env.USERPROFILE || env.HOME || '';
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin'));
    if (home) dirs.push(path.join(home, '.local/bin'), path.join(home, '.cargo/bin'));
  } else if (home) {
    dirs.push(
      path.join(home, '.local/bin'),
      path.join(home, '.npm-global/bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin'
    );
  }
  const override = env[`STUDIO_${id.toUpperCase()}_PATH`];
  if (platform === 'darwin' && id === 'codex')
    dirs.push(
      '/Applications/Codex.app/Contents/Resources',
      path.join(home, 'Applications/Codex.app/Contents/Resources')
    );
  const files = [
    ...(override ? [override] : []),
    ...dirs.flatMap((dir) => extensions.map((ext) => path.join(dir, `${id}${ext}`))),
  ];
  const found: string[] = [];
  for (const file of [...new Set(files)]) {
    try {
      const info = await fs.stat(file);
      if (info.isFile()) found.push(path.resolve(file));
    } catch {}
  }
  return found;
}
