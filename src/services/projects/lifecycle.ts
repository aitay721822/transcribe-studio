import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../../persistence/store';
import { ownedImageDirectory } from '../agents/conversation/cleanup';

import { inside } from '../workspace/files';

/** Only app-owned audio and journals are eligible for deletion; workspace roots are never touched. */
export async function removeProject(store: Store, dataDir: string, id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('無效的專案 ID');
  const meetings = store.meetings().filter((m) => m.projectId === id);
  const planned: string[] = [];
  const imageDirectories = (
    await Promise.all(meetings.map((meeting) => ownedImageDirectory(dataDir, meeting.id)))
  ).filter(Boolean);
  const audioDir = path.resolve(dataDir, 'audio');
  const journalDir = path.resolve(store.conversations.directory);
  const runtimeRoot = path.resolve(dataDir, 'runtime');
  const runtimeDirectories = [
    path.resolve(runtimeRoot, 'projects', id),
    path.resolve(runtimeRoot, 'workspaces', id),
  ];
  for (const directory of runtimeDirectories) {
    if (!inside(runtimeRoot, directory) || directory === runtimeRoot)
      throw new Error('Runtime 路徑未授權');
    try {
      if (!inside(runtimeRoot, await fs.realpath(directory)))
        throw new Error('Runtime 路徑指向應用程式目錄外');
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      if (('code' in error ? error.code : undefined) !== 'ENOENT') throw error;
    }
  }
  for (const meeting of meetings) {
    planned.push(store.conversations.filename(meeting.id));
    for (const recording of meeting.recordings)
      if (recording.path) {
        const file = path.resolve(recording.path);
        if (!inside(audioDir, file)) throw new Error('錄音路徑超出應用程式資料目錄，已中止刪除');
        planned.push(file);
      }
  }
  for (const file of planned) {
    if (!inside(audioDir, file) && !inside(journalDir, file)) throw new Error('資料路徑未授權');
    try {
      const real = await fs.realpath(file);
      if (!inside(audioDir, real) && !inside(journalDir, real))
        throw new Error('資料路徑指向應用程式目錄外');
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      if (('code' in error ? error.code : undefined) !== 'ENOENT') throw error;
    }
  }
  store.deleteProject(id);
  const warnings: string[] = [];
  for (const directory of imageDirectories)
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      warnings.push('圖片附件');
    }
  for (const directory of runtimeDirectories) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      warnings.push('專案 runtime');
    }
  }
  for (const file of planned) {
    try {
      await fs.unlink(file);
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      if (('code' in error ? error.code : undefined) !== 'ENOENT')
        warnings.push(path.basename(file));
    }
  }
  return { id, warnings };
}
