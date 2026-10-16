import { mentionFiles, releaseCursor } from '../../services/workspace/files';
import { resolveReference } from '../../services/workspace/references/resolve';
import type { DesktopContext } from '../context';

export function registerMentions({ handle, store, win }: DesktopContext) {
  const jobs = new Map<string, AbortController>();
  const cursors = new Set<string>();

  const roots = (id: string) => {
    const project = store.get('projects', id);
    if (!project) throw new Error('找不到專案');
    return project.roots;
  };

  handle('workspace:mention-cancel', (id) => {
    jobs.get(id)?.abort();
    return true;
  });
  handle('workspace:mentions', async (projectId, query, id, cursor) => {
    if (typeof id !== 'string' || id.length > 100 || jobs.has(id) || jobs.size >= 4)
      throw new Error('搜尋工作過多或代碼無效');
    if (cursor && !cursors.has(cursor)) throw new Error('搜尋游標已失效，請重新搜尋');
    const controller = new AbortController();
    jobs.set(id, controller);
    if (cursor) cursors.delete(cursor);
    try {
      const result = await mentionFiles(roots(projectId), query, {
        signal: controller.signal,
        cursor,
      });
      if (result.nextCursor) cursors.add(result.nextCursor);
      return result;
    } finally {
      jobs.delete(id);
    }
  });
  handle('workspace:mention-release', (cursor) => {
    if (cursors.delete(cursor)) releaseCursor(cursor);
    return true;
  });
  handle('workspace:resolve-reference', (projectId, rootId, relative) =>
    resolveReference(roots(projectId), rootId, relative)
  );
  win.once('closed', () => {
    for (const controller of jobs.values()) controller.abort();
    for (const cursor of cursors) releaseCursor(cursor);
  });
}
