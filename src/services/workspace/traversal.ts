import type { Dir } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceRoot } from '../../domain/models';
import { errorMessage } from '../../domain/value';
import type { WorkspaceArgs, WorkspaceEntry } from '../../domain/workspace';

export const TEXT = new Set([
  '.md',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.srt',
  '.vtt',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.yaml',
  '.yml',
  '.html',
  '.css',
  '.xml',
  '.toml',
  '.docx',
  '.log',
  '.sql',
  '.ini',
  '.rst',
]);
export const IGNORE = new Set(['node_modules', '.git', 'dist', 'release', '.next', 'coverage']);

export const excluded = (name: string) =>
  IGNORE.has(name.toLowerCase()) || name.toLowerCase().startsWith('.env');

export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export async function safePath(roots: WorkspaceRoot[], rootId: string, relative: string) {
  const root = roots.find((r) => r.id === rootId);
  if (!root) throw new Error('資料夾未授權');
  if (typeof relative !== 'string' || relative.includes('\0')) throw new Error('無效的檔案路徑');
  const realRoot = await fs.realpath(root.path),
    target = path.resolve(realRoot, relative);
  if (!inside(realRoot, target)) throw new Error('路徑超出專案工作區');
  let current = realRoot;
  for (const part of path.relative(realRoot, target).split(path.sep).filter(Boolean)) {
    if (excluded(part)) throw new Error('此檔案已排除');
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('不讀取符號連結或 junction');
  }
  const real = await fs.realpath(target);
  if (!inside(realRoot, real)) throw new Error('路徑超出專案工作區');
  return real;
}

export function progressState() {
  return {
    visited: 0,
    files: 0,
    scannedFiles: 0,
    bytes: 0,
    matches: 0,
    skipped: 0,
    errorCount: 0,
    errors: [] as string[],
  };
}

export function recordError(stats: ReturnType<typeof progressState>, file: string, error: unknown) {
  stats.errorCount++;
  if (stats.errors.length < 20) stats.errors.push(`${file}: ${errorMessage(error)}`.slice(0, 1000));
}

/** Directory buffers and the active DFS path are retained, never a whole tree. */
export async function* walk(
  roots: WorkspaceRoot[],
  stats: ReturnType<typeof progressState>,
  signal: AbortSignal,
  options: WorkspaceArgs = {}
): AsyncGenerator<WorkspaceEntry, void, unknown> {
  const stack: { root: WorkspaceRoot; dir: Dir }[] = [];
  try {
    for (const root of roots) {
      if (options.rootId && root.id !== options.rootId) continue;
      signal.throwIfAborted();
      let rootPath: string;
      try {
        rootPath = await fs.realpath(root.path);
        const start = options.directory
          ? await safePath(roots, root.id, options.directory)
          : rootPath;
        stack.push({ root, dir: await fs.opendir(start) });
        if (options.includeDirectories)
          yield {
            rootId: root.id,
            rootName: root.name,
            relative: path.relative(rootPath, start),
            kind: 'directory',
          };
      } catch (caughtE) {
        const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

        recordError(stats, root.name, e);
        yield null;
        continue;
      }
      while (stack.length) {
        signal.throwIfAborted();
        const frame = stack.at(-1);
        let entry;
        try {
          entry = await frame.dir.read();
        } catch (caughtE) {
          const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

          recordError(stats, frame.dir.path, e);
        }
        if (!entry) {
          await frame.dir.close().catch(() => {});
          stack.pop();
          continue;
        }
        stats.visited++;
        if (excluded(entry.name) || entry.isSymbolicLink()) {
          stats.skipped++;
          yield null;
          continue;
        }
        const absolute = path.join(frame.dir.path, entry.name);
        if (entry.isDirectory()) {
          try {
            const checked = await safePath(roots, root.id, path.relative(rootPath, absolute));
            stack.push({ root, dir: await fs.opendir(checked) });
          } catch (caughtE) {
            const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

            recordError(stats, absolute, e);
          }
          yield options.includeDirectories
            ? {
                rootId: root.id,
                rootName: root.name,
                relative: path.relative(rootPath, absolute),
                kind: 'directory',
              }
            : null;
        } else if (entry.isFile() && TEXT.has(path.extname(entry.name).toLowerCase())) {
          stats.files++;
          yield {
            rootId: root.id,
            rootName: root.name,
            relative: path.relative(rootPath, absolute),
            ...(options.includeDirectories ? { kind: 'file' } : {}),
          };
        } else {
          stats.skipped++;
          yield null;
        }
      }
    }
  } finally {
    for (const frame of stack) await frame.dir.close().catch(() => {});
  }
}
