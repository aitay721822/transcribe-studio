import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Project, WorkspaceRoot } from '../../domain/models';

export class ProjectEditSessions {
  private sessions = new Map<string, { project: Project; roots: WorkspaceRoot[] }>();

  begin(project: Project) {
    if (!project) throw new Error('找不到專案');
    if (this.sessions.size >= 20) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomUUID();
    this.sessions.set(token, { project: structuredClone(project), roots: [...project.roots] });
    return token;
  }

  private get(token: string) {
    const session = this.sessions.get(token);
    if (!session) throw new Error('編輯已結束，請重新開啟專案');
    return session;
  }

  async add(token: string, selectedPaths: string[]) {
    const session = this.get(token);
    const selected: WorkspaceRoot[] = [];

    const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);

    for (const selectedPath of selectedPaths) {
      const resolved = await realpath(selectedPath);
      if (!(await stat(resolved)).isDirectory()) throw new Error('請選擇資料夾');
      this.get(token);
      let root = session.roots.find((r) => key(r.path) === key(resolved));
      if (!root) {
        root = {
          id: randomUUID(),
          path: resolved,
          name: path.basename(resolved) || resolved,
          mode: 'readonly',
        };
        session.roots.push(root);
      }
      if (!selected.some((r) => r.id === root.id)) selected.push(root);
    }
    return selected;
  }

  prepare(token: string, current: Project, name: string, rootIds: string[]) {
    const session = this.get(token);
    if (!current || current.id !== session.project.id) throw new Error('找不到專案');
    if (JSON.stringify(current) !== JSON.stringify(session.project))
      throw new Error('專案已變更，請關閉並重新編輯');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120)
      throw new Error('請輸入 1–120 字的專案名稱');
    if (!Array.isArray(rootIds) || new Set(rootIds).size !== rootIds.length)
      throw new Error('資料夾清單無效');
    const roots = rootIds.map((id) => {
      const root = session.roots.find((r) => r.id === id);
      if (!root) throw new Error('資料夾未經選取，請重新新增');
      return root;
    });
    return { name: name.trim(), roots };
  }

  projectId(token: string) {
    return this.get(token).project.id;
  }

  end(token: string) {
    this.sessions.delete(token);
  }
}
