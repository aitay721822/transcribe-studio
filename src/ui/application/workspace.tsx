import { rebaseAnnotations } from '../../domain/annotations';
import { discardTemporary } from '../agent/session/temporary';
import { date, markdown } from '../components/display';
import { invalidateUI } from '../layout/roots';
import { Button } from '../primitives/button';
import { $, type UiRuntime } from './runtime';

export function createWorkspaceController(host: UiRuntime) {
  const {
    state,
    api,
    current,
    updateMeeting,
    applyInputState,
    toast,
    safe,
    showModal,
    render,
    startSetup,
  } = host;

  async function saveNotes() {
    clearTimeout(state.saveTimer);
    if (!current() || !state.dirty) return;
    const id = current().id;
    const notes = $('#notes-editor')?.value ?? current().notes;
    // Serialize saves to preserve version checks while typing during a save.
    if (state.saving) {
      await state.saving;
      if (state.dirty) return saveNotes();
      return;
    }
    state.saving = (async () => {
      const m = await api(
        'meeting:update',
        id,
        {
          notes,
        },
        current().version
      );
      const latest = state.meetings.find((x) => x.id === id);
      const edited = latest.notes;
      updateMeeting({
        ...m,
        notes: edited,
        annotations: rebaseAnnotations(m.annotations || [], notes, edited),
      });
      state.dirty = edited !== notes;
      if (!state.dirty) updateMeeting(m);
      invalidateUI();
    })();
    try {
      await state.saving;
    } finally {
      state.saving = null;
    }
  }

  async function navigate(view: string) {
    if (host.requireSetup()) return;
    await saveNotes();
    if (view !== 'workspace') discardTemporary(state);
    state.view = view;
    if (view === 'project' || view === 'settings') await loadWorkspace();
    render();
  }

  async function loadWorkspace() {
    if (!state.projectId) {
      state.skills = [];
      return;
    }
    state.skills = await api('skills:list', state.projectId);
  }

  async function openMeeting(id: string) {
    if (host.requireSetup()) return;
    if (state.runId && state.meetingId !== id && !state.temporaryChat)
      throw new Error('請先完成或停止目前的 Agent 工作');
    await saveNotes();
    if (state.meetingId !== id) discardTemporary(state);
    if (state.meetingId !== id) {
      state.proposal = null;
      state.agentEvents = [];
      state.runId = null;
    }
    const m = await api('meeting:get', id);
    updateMeeting(m);
    state.meetingId = id;
    state.selectionLength = 0;
    state.noteSelection = undefined;
    state.projectId = m.projectId;
    state.view = 'workspace';
    state.dirty = false;
    applyInputState(await api('agent:input-state', id));
    const trace = await api('agent:trace', id);
    if (trace) {
      const saved = trace.events.map((event) => ({ ...event, runId: trace.runId, meetingId: id }));
      const live = state.agentEvents.filter((event) => event.runId === trace.runId);
      const seen = new Set(saved.map((event) => event.id || JSON.stringify(event)));
      state.agentEvents = [
        ...saved,
        ...live.filter((event) => !seen.has(event.id || JSON.stringify(event))),
      ];
    }
    await loadWorkspace();
    render();
  }

  async function deleteMeeting(id: string) {
    if (host.capture.starting) throw new Error('請先完成音訊裝置連線');
    const meeting = state.meetings.find((m) => m.id === id);
    if (!meeting) throw new Error('找不到會議');
    await saveNotes();
    const modal = showModal(
      '刪除會議',
      <>
        <p>刪除「{meeting.title}」的會議紀錄、版本歷史、Agent 對話及本機錄音。此操作無法復原。</p>
        <p className="help">其他會議與參考資料夾會保留。</p>
      </>,
      <>
        <Button
          variant="outline"
          className="btn"
          id="cancel-delete-meeting"
          onClick={() => modal.close()}
        >
          取消
        </Button>
        <Button
          variant="destructive"
          className="btn danger"
          id="confirm-delete-meeting"
          onClick={safe(async (event) => {
            const confirm = event.currentTarget;
            confirm.disabled = true;
            try {
              const result = await api('meeting:delete', id);
              state.meetings = state.meetings.filter((m) => m.id !== id);
              modal.close();
              if (state.meetingId === id) {
                state.meetingId = null;
                state.proposal = null;
                state.runId = null;
                state.agentEvents = [];
                state.dirty = false;
                clearTimeout(state.saveTimer);
                await navigate('project');
              } else render();
              toast(
                result.warnings.length
                  ? `會議已刪除，部分檔案未能清除：${result.warnings.join('、')}`
                  : '會議已刪除',
                !!result.warnings.length
              );
            } finally {
              confirm.disabled = false;
            }
          })}
        >
          刪除會議
        </Button>
      </>
    );
  }

  async function revisions() {
    await saveNotes();
    const revs = await api('meeting:revisions', state.meetingId);

    const viewRevision = (r: import('../../persistence/store').Revision) =>
      showModal(
        `版本 ${r.version}`,
        <div className="document-preview">{markdown(r.notes, undefined, current())}</div>,
        <Button
          className="btn primary"
          id="restore-revision"
          onClick={safe(async () => {
            await saveNotes();
            updateMeeting(
              await api(
                'meeting:update',
                state.meetingId,
                {
                  notes: r.notes,
                },
                current().version
              )
            );
            $<HTMLDialogElement>('#modal').close();
            render();
            toast('已還原，還原前的內容也已保留');
          })}
        >
          還原為此版本
        </Button>
      );

    showModal(
      '版本歷史',
      revs.length ? (
        revs.map((r) => (
          <div className="revision-item" key={r.id}>
            <div>
              版本 {r.version}
              <small>
                {date(r.createdAt, true)} · {r.notes.length} 字
              </small>
            </div>
            <Button
              className="btn small"
              variant="outline"
              size="sm"
              data-revision={r.id}
              onClick={() => viewRevision(r)}
            >
              查看與還原
            </Button>
          </div>
        ))
      ) : (
        <p className="help">編輯並儲存後，舊版本會保存在這裡。</p>
      )
    );
  }

  async function exportDocument() {
    await saveNotes();
    const modal = showModal(
      '匯出 Word 文件',
      <>
        <label className="check-line">
          <input type="checkbox" id="export-transcript" />
          包含逐字稿附錄
        </label>
        <p className="help">會議紀錄中的標題、清單與表格會轉換成 Word 格式。</p>
      </>,
      <Button
        variant="default"
        className="btn primary"
        id="do-export"
        onClick={safe(async () => {
          const p = await api('export:docx', state.meetingId, $('#export-transcript').checked);
          if (p) {
            modal.close();
            toast(`Word 文件已匯出：${p}`);
          }
        })}
      >
        選擇儲存位置
      </Button>
    );
  }

  return {
    saveNotes,
    navigate,
    loadWorkspace,
    openMeeting,
    deleteMeeting,
    revisions,
    exportDocument,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
