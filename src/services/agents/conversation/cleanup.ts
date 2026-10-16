import fs from 'node:fs/promises';
import path from 'node:path';

export async function ownedImageDirectory(dataDir: string, id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('圖片資料夾代碼無效');
  const root = path.resolve(dataDir, 'attachments'),
    directory = path.resolve(root, id);
  if (path.dirname(directory) !== root) throw new Error('圖片路徑未授權');
  try {
    const actualRoot = await fs.realpath(root),
      actual = await fs.realpath(directory);
    if (path.dirname(actual) !== actualRoot || (await fs.lstat(directory)).isSymbolicLink())
      throw new Error('圖片資料夾路徑超出應用程式');
    return directory;
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

    if (('code' in error ? error.code : undefined) === 'ENOENT') return null;
    throw error;
  }
}
