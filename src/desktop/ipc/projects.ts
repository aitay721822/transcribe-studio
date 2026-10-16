import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dialog, shell } from 'electron';
import type { WorkspaceOptions } from '../../domain/workspace';
import { discoverSkills } from '../../harness/skills';
import { ProjectEditSessions } from '../../services/projects/edit-session';
import { removeProject } from '../../services/projects/lifecycle';
import * as workspace from '../../services/workspace/files';
import type { DesktopContext } from '../context';
import { registerMentions } from '../workspace/mentions';

export function registerProjects(ctx: DesktopContext) {
  const { handle, win, store, sanitizeMeeting, settingsPublic } = ctx;
  const edits = new ProjectEditSessions();
  registerMentions(ctx);
  handle('project:organize', (id, patch) => {
    if (!store.get('projects', id)) throw new Error('找不到專案');
    if (!patch || typeof patch !== 'object') throw new Error('專案設定無效');
    const update: { pinned?: boolean; section?: string } = {};
    if ('pinned' in patch) {
      if (typeof patch.pinned !== 'boolean') throw new Error('置頂狀態無效');
      update.pinned = patch.pinned;
    }
    if ('section' in patch) {
      if (typeof patch.section !== 'string' || patch.section.trim().length > 60)
        throw new Error('區段名稱不能超過 60 字');
      update.section = patch.section.trim();
    }
    return store.updateProject(id, update);
  });
  handle('project:open-folder', async (id, rootId) => {
    const p = store.get('projects', id);
    if (!p) throw new Error('找不到專案');
    const root = rootId ? p.roots.find((r) => r.id === rootId) : p.roots[0];
    if (!root) throw new Error('請先加入參考資料夾');
    const resolved = await fsp.realpath(root.path);
    if (!(await fsp.stat(resolved)).isDirectory()) throw new Error('來源資料夾不存在');
    const error = await shell.openPath(resolved);
    if (error) throw new Error(error);
  });
  handle('bootstrap', () => ({
    projects: store.projects(),
    meetings: store.meetings().map(sanitizeMeeting),
    settings: settingsPublic(),
    platform: process.platform,
  }));
  handle('project:create', (name) => store.createProject(name));

  const ensureIdle = (id: string) => {
    const meetings = store.meetings().filter((m) => m.projectId === id);
    const ids = meetings.map((m) => m.id);
    if (
      [...ctx.recordings.values()].some((r) => ids.includes(r.meetingId)) ||
      ids.some((mid) => ctx.agent.isRunningMeeting(mid)) ||
      meetings.some((m) => m.status === 'transcribing')
    )
      throw new Error('請先結束此專案的錄音、辨識與 Agent 工作');
  };

  handle('project:archive', (id, archived) => {
    if (typeof archived !== 'boolean') throw new Error('封存狀態無效');
    ensureIdle(id);
    return store.updateProject(id, { archivedAt: archived ? new Date().toISOString() : null });
  });
  handle('project:delete', async (id) => {
    ensureIdle(id);
    return removeProject(store, ctx.dataDir, id);
  });
  handle('project:rename', (id, name) =>
    store.updateProject(id, { name: String(name).trim().slice(0, 120) })
  );
  handle('project:edit-begin', (id) => edits.begin(store.get('projects', id)));
  handle('project:edit-end', (token) => edits.end(token));
  handle(
    'project:pick-folders',
    async (token): Promise<import('../../domain/models').WorkspaceRoot[]> => {
      edits.projectId(token);
      const result = await dialog.showOpenDialog(win, {
        title: '加入專案參考資料夾',
        properties: ['openDirectory', 'multiSelections'],
      });
      return result.canceled ? [] : edits.add(token, result.filePaths);
    }
  );
  handle('project:edit-save', (token, name, rootIds) => {
    const id = edits.projectId(token);
    const current = store.get('projects', id);
    const patch = edits.prepare(token, current, name, rootIds);
    if (JSON.stringify(patch.roots) !== JSON.stringify(current.roots)) ensureIdle(id);
    const updated = store.updateProject(id, patch);
    edits.end(token);
    return updated;
  });
  handle('project:folders', async (id) => {
    const p = store.get('projects', id);
    if (!p) throw new Error('找不到專案');
    const result = await dialog.showOpenDialog(win, {
      title: '加入專案參考資料夾',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (result.canceled) return p;
    const roots = [...p.roots];
    for (const file of result.filePaths) {
      const real = await fsp.realpath(file);
      if (!roots.some((r) => r.path.toLowerCase() === real.toLowerCase()))
        roots.push({ id: randomUUID(), path: real, name: path.basename(real), mode: 'readonly' });
    }
    return store.updateProject(id, { roots });
  });
  handle('project:remove-root', (id, rootId) => {
    const p = store.get('projects', id);
    return store.updateProject(id, { roots: p.roots.filter((r) => r.id !== rootId) });
  });
  handle('workspace:list', (id, query, options: WorkspaceOptions = {}) =>
    workspace.listFiles(store.get('projects', id)?.roots || [], query, {
      cursor: options.cursor,
      limit: options.limit,
    })
  );
  handle('workspace:read', (id, rootId, relative) =>
    workspace.readFile(store.get('projects', id)?.roots || [], rootId, relative)
  );
  handle('workspace:read-page', (id, rootId, relative, options: WorkspaceOptions = {}) =>
    workspace.readFilePage(store.get('projects', id)?.roots || [], rootId, relative, {
      offset: options.offset,
      limit: options.limit,
      version: options.version,
    })
  );
  handle('workspace:release', (cursor) => {
    workspace.releaseCursor(cursor);
    return true;
  });
  handle('skills:list', (id) =>
    discoverSkills(store.get('projects', id)?.roots || [], ctx.bundledSkills).then((ss) =>
      ss.map(({ id, name, description }) => ({ id, name, description }))
    )
  );
}
