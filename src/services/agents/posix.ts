import fs from 'node:fs/promises';
import path from 'node:path';

export async function posixCommand(file: string, runtime = process.execPath) {
  const target = await fs.realpath(file);
  const handle = await fs.open(target, 'r');
  let header: string;
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
  } finally {
    await handle.close();
  }
  if (/\.(m?js|cjs)$/i.test(target) || (/^#!/.test(header) && /\bnode\b/.test(header)))
    return { executable: runtime, args: [target] };
  await fs.access(target, fs.constants.X_OK);
  return { executable: target, args: [] as string[] };
}

/** Discover known installations without executing a user's shell startup files. */
export async function posixDirectories(env: NodeJS.ProcessEnv) {
  const home = env.HOME || '';
  const dirs = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  if (!home) return dirs;
  dirs.unshift(
    ...[
      '.local/bin',
      '.npm-global/bin',
      '.volta/bin',
      '.asdf/shims',
      '.bun/bin',
      'Library/pnpm',
      '.local/share/mise/shims',
    ].map((name) => path.join(home, name))
  );
  for (const directory of [
    path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions/node'),
    path.join(home, '.local/share/mise/installs/node'),
  ]) {
    try {
      const entries = (await fs.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      dirs.push(...entries.slice(0, 10).map((entry) => path.join(directory, entry.name, 'bin')));
    } catch {
      // Installation managers are optional.
    }
  }
  return dirs;
}

export async function prepareRuntimePath(platform = process.platform, env = process.env) {
  if (platform === 'win32') return;
  const paths = [...(env.PATH || '').split(':').filter(Boolean), ...(await posixDirectories(env))];
  env.PATH = [...new Set(paths)].join(':');
}
