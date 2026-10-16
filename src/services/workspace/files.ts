import type { WorkspaceRoot } from '../../domain/models';
import type { WorkspaceOptions } from '../../domain/workspace';
import { closeWorkspace, releaseCursor, workspaceRequest } from './client';

export { inside, safePath } from './traversal';
export { closeWorkspace, releaseCursor };

export function listFiles(roots: WorkspaceRoot[], query = '', options: WorkspaceOptions = {}) {
  return workspaceRequest(
    'list',
    roots,
    {
      query,
      cursor: options.cursor,
      limit: options.limit,
      rootId: options.rootId,
      directory: options.directory,
    },
    options
  );
}

export function searchFiles(roots: WorkspaceRoot[], query: string, options: WorkspaceOptions = {}) {
  return workspaceRequest(
    'search',
    roots,
    {
      query,
      cursor: options.cursor,
      limit: options.limit,
      pathQuery: options.pathQuery || '',
      caseSensitive: !!options.caseSensitive,
      rootId: options.rootId,
      directory: options.directory,
    },
    options
  );
}

export function mentionFiles(roots: WorkspaceRoot[], query = '', options: WorkspaceOptions = {}) {
  return workspaceRequest('mentions', roots, { query, cursor: options.cursor, limit: 20 }, options);
}

export function readFilePage(
  roots: WorkspaceRoot[],
  rootId: string,
  relative: string,
  options: WorkspaceOptions = {}
) {
  return workspaceRequest(
    'read',
    roots,
    { rootId, relative, offset: options.offset, limit: options.limit, version: options.version },
    options
  );
}

/** Compatibility for small-file consumers; never silently truncate a large document. */
export async function readFile(roots: WorkspaceRoot[], rootId: string, relative: string) {
  const page = await readFilePage(roots, rootId, relative, { limit: 64000 });
  if (page.nextOffset !== null)
    throw new Error('檔案需分段讀取，請使用 studio_read_file 的 nextOffset');
  return page.text;
}
