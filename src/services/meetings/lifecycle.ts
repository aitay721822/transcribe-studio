import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../../persistence/store';
import { ownedImageDirectory } from '../agents/conversation/cleanup';

import { inside } from '../workspace/files';

export async function removeMeeting(
  store: Store,
  dataDir: string,
  id: string,
  assertIdle: () => void = () => {}
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('無效的會議 ID');
  const meeting = store.get('meetings', id);
  if (!meeting) throw new Error('找不到會議');
  assertIdle();
  const imageDirectory = await ownedImageDirectory(dataDir, id);
  const audioDir = path.resolve(dataDir, 'audio');
  const journalDir = path.resolve(store.conversations.directory);
  const actualDataDir = await fs.realpath(dataDir);
  const actualAudioDir = path.resolve(actualDataDir, 'audio');
  const actualJournalDir = path.resolve(
    actualDataDir,
    path.relative(path.resolve(dataDir), journalDir)
  );
  const shared = new Set<string>(
    store
      .meetings()
      .filter((m) => m.id !== id)
      .flatMap((m) => m.recordings.filter((r) => r.path).map((r) => path.resolve(r.path)))
  );
  const audio = meeting.recordings.filter((r) => r.path).map((r) => path.resolve(r.path));
  for (const file of audio)
    if (!inside(audioDir, file)) throw new Error('錄音路徑超出應用程式資料目錄，已中止刪除');
  const journal = path.resolve(store.conversations.filename(id));
  if (!inside(journalDir, journal)) throw new Error('對話資料路徑未授權');
  const planned = [...new Set([journal, ...audio.filter((file) => !shared.has(file))])];
  for (const file of planned) {
    const directory = file === journal ? actualJournalDir : actualAudioDir;
    try {
      if (!inside(directory, await fs.realpath(file)))
        throw new Error('資料路徑指向應用程式目錄外');
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      if (('code' in error ? error.code : undefined) !== 'ENOENT') throw error;
    }
  }
  assertIdle();
  store.deleteMeeting(id);
  const warnings: string[] = [];
  if (imageDirectory)
    try {
      await fs.rm(imageDirectory, { recursive: true, force: true });
    } catch {
      warnings.push('圖片附件');
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
  return { id, projectId: meeting.projectId, warnings };
}
