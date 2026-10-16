import type { ContextReference, WorkspaceRoot } from '../models';
import { record } from '../value';

export function contextReferences(
  value: unknown,
  roots: WorkspaceRoot[]
): ContextReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new Error('每則訊息最多指定 20 個參考項目');
  return (value as unknown[]).map((value) => {
    const r = record(value);
    if (r?.kind === 'search') {
      if (
        typeof r.query !== 'string' ||
        !r.query.trim() ||
        r.query.length > 200 ||
        /[\r\n]/.test(r.query)
      )
        throw new Error('搜尋關鍵字須為 1–200 字元的單行文字');
      return { kind: 'search', query: r.query.trim() };
    }
    const root = roots.find((root) => root.id === r?.rootId);
    if (
      !root ||
      !['file', 'directory'].includes(String(r.kind)) ||
      typeof r.relative !== 'string' ||
      r.relative.length > 2000 ||
      r.relative.includes('\0')
    )
      throw new Error('參考項目無效或資料夾已取消授權');
    const relative = String(r.relative).replaceAll('\\', '/');
    if (/^(?:\/|[a-z]:)/i.test(relative) || relative.split('/').some((part) => part === '..'))
      throw new Error('參考項目路徑超出專案工作區');
    return { kind: r.kind as 'file' | 'directory', rootId: root.id, rootName: root.name, relative };
  });
}
