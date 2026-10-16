import { openProjectEditor } from '../components/project-editor';
import { Button } from '../primitives/button';
import type { ProjectCommand } from '../projects/menu';
import type { UiRuntime } from './runtime';
import type { WorkspaceController } from './workspace';

export function createProjectController(host: UiRuntime, workspace: WorkspaceController) {
  const { state, api, project, toast, showModal, askName, safe, render } = host;
  const { saveNotes, navigate, loadWorkspace } = workspace;

  async function editProject(removeRootId?: string) {
    if (!project()) return createProject();
    await saveNotes();
    const editing = structuredClone(project());
    const token = await api('project:edit-begin', editing.id);
    let result;
    try {
      result = await openProjectEditor({
        project: editing,
        removeRootId,
        showModal,

        pickFolders: () => api('project:pick-folders', token),

        save: (name, roots) => api('project:edit-save', token, name, roots),
      });
    } finally {
      await api('project:edit-end', token);
    }
    if (result === 'remove') return deleteProject();
    if (result) {
      state.projects[state.projects.findIndex((p) => p.id === result.id)] = result;
      await loadWorkspace();
      render();
    }
  }

  async function activateProject(id: string) {
    if (state.projectId === id) return;
    if (state.runId && !state.temporaryChat) throw new Error('請先完成或停止目前的 Agent 工作');
    await saveNotes();
    state.projectId = id;
    state.meetingId = null;
    state.proposal = null;
    state.agentEvents = [];
    await navigate('project');
  }

  async function projectCommand(id: string, command: ProjectCommand, value?: string) {
    if (command === 'create') return createProject();
    const selected = state.projects.find((p) => p.id === id);
    if (!selected) throw new Error('找不到專案');
    if (command === 'open') return api('project:open-folder', id, value);
    if (command === 'pin' || command === 'section' || command === 'new-section') {
      let section = value || '';
      if (command === 'new-section') {
        section = await askName('新增區段', '區段名稱');
        if (!section) return;
      }
      const updated = await api(
        'project:organize',
        id,
        command === 'pin'
          ? {
              pinned: !selected.pinned,
            }
          : {
              section,
            }
      );
      state.projects[state.projects.findIndex((p) => p.id === id)] = updated;
      render();
      return;
    }
    await activateProject(id);
    if (command === 'edit') return editProject();
    if (command === 'archive') return archiveProject();
    if (command === 'remove') return deleteProject();
  }

  async function createProject() {
    const name = await askName('新增專案', '專案名稱');
    if (!name) return;
    const p = await api('project:create', name);
    state.projects.push(p);
    state.projectId = p.id;
    await navigate('project');
    toast('專案已建立，可加入多個參考資料夾');
  }

  async function archiveProject() {
    if (!project()) return;
    if (host.capture.starting) throw new Error('請先完成音訊裝置連線');
    await saveNotes();
    const p = await api('project:archive', state.projectId, !project().archivedAt);
    state.projects[state.projects.findIndex((item) => item.id === p.id)] = p;
    render();
    toast(p.archivedAt ? '專案已封存' : '已解除封存');
  }

  async function deleteProject() {
    if (host.capture.starting) throw new Error('請先完成音訊裝置連線');
    const p = project();
    if (!p) return;
    await saveNotes();
    const count = state.meetings.filter((m) => m.projectId === p.id).length;
    const modal = showModal(
      '刪除專案',
      <>
        <p>
          刪除「{p.name}」與 {count} 場會議，包括紀錄、對話及本機錄音。此操作無法復原。
        </p>
        <p className="help">參考工作區資料夾不會被刪除。</p>
      </>,
      <>
        <Button
          variant="outline"
          className="btn"
          id="cancel-delete-project"
          onClick={() => modal.close()}
        >
          取消
        </Button>
        <Button
          variant="destructive"
          className="btn danger"
          id="confirm-delete-project"
          onClick={safe(async () => {
            const result = await api('project:delete', p.id);
            state.projects = state.projects.filter((item) => item.id !== p.id);
            state.meetings = state.meetings.filter((m) => m.projectId !== p.id);
            state.projectId = state.projects.find((item) => !item.archivedAt)?.id || null;
            state.meetingId = null;
            state.proposal = null;
            state.agentEvents = [];
            state.dirty = false;
            modal.close();
            await navigate('project');
            toast(
              result.warnings.length
                ? `專案已刪除，部分錄音檔案未能清除：${result.warnings.join('、')}`
                : '專案已刪除',
              !!result.warnings.length
            );
          })}
        >
          刪除專案
        </Button>
      </>
    );
  }

  return {
    editProject,
    activateProject,
    projectCommand,
    createProject,
    archiveProject,
    deleteProject,
  };
}

export type ProjectController = ReturnType<typeof createProjectController>;
