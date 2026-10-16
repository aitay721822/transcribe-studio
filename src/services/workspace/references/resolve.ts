import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceRoot } from '../../../domain/models';
import { contextReferences } from '../../../domain/references/context';
import { safePath, TEXT } from '../traversal';

export async function resolveReference(roots: WorkspaceRoot[], rootId: string, relative: string) {
  const checked = await safePath(roots, rootId, relative);
  const stat = await fs.stat(checked);

  const referenceKind = () => {
    if (stat.isDirectory()) {
      return 'directory';
    }
    if (stat.isFile()) {
      return 'file';
    }
    return null;
  };

  const kind: 'directory' | 'file' | null = referenceKind();
  if (!kind) throw new Error('只能指定一般檔案或資料夾');
  if (kind === 'file' && !TEXT.has(path.extname(checked).toLowerCase()))
    throw new Error('目前支援文字、程式碼與 DOCX；此檔案請先轉成文字格式');
  const root = roots.find((r) => r.id === rootId);
  return {
    kind,
    rootId,
    rootName: root.name,
    relative: path.relative(await fs.realpath(root.path), checked).replaceAll('\\', '/'),
  };
}

export async function validateReferences(roots: WorkspaceRoot[], value: unknown) {
  const refs = contextReferences(value, roots);
  if (!refs) return undefined;
  return Promise.all(
    refs.map(async (r) => {
      if (r.kind === 'search') return r;
      const actual = await resolveReference(roots, r.rootId, r.relative);
      if (actual.kind !== r.kind) throw new Error('參考項目的類型已變更，請重新選取');
      return actual;
    })
  );
}
