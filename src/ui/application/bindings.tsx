import type { HTMLAttributes } from 'react';
import { rebaseAnnotations } from '../../domain/annotations';
import { RecordingTaskDialog } from '../audio/tasks/recording-dialog';
import { closeDropdown } from '../components/dropdown';
import { invalidateUI } from '../layout/roots';
import { FilePreview } from '../projects/files/preview';
import { closeProjectMenu, openProjectMenu } from '../projects/menu';
import type { Controllers } from './integration/contracts';
import { actionShortcut } from './platform/shortcuts';
import { $, type UiRuntime } from './runtime';

/** React event delegation keeps the feature controllers independent of presentation. */
export function applicationEvents(
  host: UiRuntime,
  controllers: Controllers
): HTMLAttributes<HTMLDivElement> {
  const { state, api, current, updateMeeting, toast, applyTheme, safe, showModal, render } = host;
  const { workspace, projects, audio, agent, settings, actions } = controllers;
  const click = safe(async (event: React.MouseEvent<HTMLDivElement>) => {
    const b = (event.target as Element).closest<HTMLElement>('button, [data-meeting]');
    if (!b) return;
    const d = b.dataset;
    if (d.window) {
      await api('window:control', d.window);
      return;
    }
    if (state.view === 'setup' || host.requireSetup()) return;
    if (d.cancelAudio) await api('audio:cancel', d.cancelAudio);
    else if (d.steerInput) {
      const result = await api('agent:promote', d.steerInput, state.runId);
      host.applyInputState(await api('agent:input-state', state.meetingId));
      agent.updateAgentFeed();
      toast(result.disposition === 'steered' ? '已引導目前工作' : '引導未被接受，訊息仍在佇列');
    } else if (d.annotationEdit) await controllers.annotations.edit(d.annotationEdit);
    else if (d.annotationRemove) await controllers.annotations.remove(d.annotationRemove);
    else if (d.deleteMeeting) {
      event.stopPropagation();
      await workspace.deleteMeeting(d.deleteMeeting);
    } else if (d.action) await actions[d.action]?.();
    else if (d.view) await workspace.navigate(d.view);
    else if (d.window) await api('window:control', d.window);
    else if (d.audioMode) {
      state.audioSourceMode = d.audioMode as 'device' | 'file';
      render();
    } else if (d.project || d.taskProject) {
      if (state.runId && !state.temporaryChat) throw new Error('請先完成或停止目前的 Agent 工作');
      await workspace.saveNotes();
      state.projectId = d.project || d.taskProject || null;
      state.meetingId = null;
      await workspace.navigate('project');
    } else if (d.projectMenu !== undefined) {
      if (b.getAttribute('aria-expanded') === 'true') {
        closeProjectMenu();
        b.focus();
        return;
      }
      closeDropdown();
      openProjectMenu(
        b as HTMLButtonElement,
        state.projects.find((p) => p.id === d.projectMenu),
        state.projects,
        (command, value) => {
          void safe(() => projects.projectCommand(d.projectMenu, command, value))(null);
        }
      );
    } else if (d.projectEdit) {
      await projects.activateProject(d.projectEdit);
      await projects.editProject();
    } else if (d.meeting) await workspace.openMeeting(d.meeting);
    else if (d.source) {
      state.source = d.source;
      render();
    } else if (d.removeFile) {
      state.selectedFiles = state.selectedFiles.filter((f) => f.id !== d.removeFile);
      render();
    } else if (d.removeRoot) await projects.editProject(d.removeRoot);
    else if (d.sourceTab) {
      await workspace.saveNotes();
      state.sourceTab = d.sourceTab;
      render();
    } else if (d.editorTab) {
      await workspace.saveNotes();
      state.editorTab = d.editorTab;
      render();
    } else if (d.settingsTab) {
      state.settings = settings.collectSettings();
      state.settingsTab = d.settingsTab;
      render();
    } else if (d.themeOption) {
      state.settings.theme = d.themeOption;
      applyTheme(d.themeOption);
      render();
    } else if (d.prompt) {
      $('#agent-input').value = d.prompt;
      $('#agent-input').focus();
    } else if (d.readFile) {
      const projectId = state.projectId;
      showModal(
        d.readFile,
        <FilePreview
          rootId={d.readRoot}
          relative={d.readFile}
          read={(rootId, relative, options) =>
            api('workspace:read-page', projectId, rootId, relative, options)
          }
        />
      );
    } else if (d.seek) await audio.seekAudio(Number(d.seek), d.recording);
    else if (d.retranscribe) {
      const target = d.recoveryMeeting ? await api('meeting:get', d.recoveryMeeting) : current();
      const modal = showModal(
        '建立會後補辨識任務',
        <RecordingTaskDialog
          meeting={target}
          recordingId={d.retranscribe}
          denoise={state.audioDenoise !== false}
          queued={(meeting) => {
            updateMeeting(meeting);
            modal.close();
            render();
            toast('已加入補辨識任務，可在辨識任務面板管理');
          }}
        />
      );
    } else if (d.cancelInput) {
      const item = state.agentQueue?.find((entry) => entry.id === d.cancelInput);
      await api('agent:cancel', d.cancelInput);
      if (item?.messageId)
        state.discardedChatIds = [...(state.discardedChatIds || []), item.messageId];
      agent.updateAgentFeed();
    } else if (d.approval) {
      await api('agent:approve', d.approval, d.answer === 'yes');
      state.agentEvents = state.agentEvents.filter((e) => e.id !== d.approval);
      agent.updateAgentFeed();
    }
  });
  const change = safe(async (event: React.FormEvent<HTMLDivElement>) => {
    const input = event.target as HTMLInputElement;
    switch (input.id) {
      case 'llm-backend':
      case 'codex-auth':
      case 'claude-auth':
      case 'asr-flavor':
        state.settings = settings.collectSettings();
        render();
        break;
      case 'record-only':
        state.recordOnly = input.checked;
        break;
      case 'live-project':
      case 'import-project':
        state.projectId = input.value;
        break;
      case 'status-filter':
        state.statusFilter = input.value;
        render();
        break;
      case 'meeting-title': {
        const title = input.value.trim();
        if (!title) {
          input.value = current().title;
          break;
        }
        await workspace.saveNotes();
        updateMeeting(
          await api('meeting:update', state.meetingId, {
            title,
          })
        );
        invalidateUI();
        break;
      }
    }
  });
  return {
    onClick: click,
    onChange: change,
    onKeyDown: safe(async (event) => {
      if (
        (event.target as HTMLElement).id !== 'agent-input' ||
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.altKey ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || host.requireSetup()) return;

      const submissionMode = () => {
        if (event.ctrlKey || event.metaKey) {
          return 'queue';
        }
        if (state.runId) {
          return 'steer';
        }
        return 'queue';
      };

      await agent.runAgent(submissionMode());
    }),

    onInput: (event) => {
      const input = event.target as HTMLInputElement;
      if (input.id === 'notes-editor') {
        if (state.annotationDrafts?.[state.meetingId])
          state.annotationDrafts[state.meetingId] = rebaseAnnotations(
            state.annotationDrafts[state.meetingId],
            current().notes,
            input.value
          );
        current().annotations = rebaseAnnotations(
          current().annotations || [],
          current().notes,
          input.value
        );
        current().notes = input.value;
        state.dirty = true;
        invalidateUI();
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(
          () => workspace.saveNotes().catch((e) => toast(e.message, true)),
          800
        );
      } else if (input.id === 'meeting-search') {
        state.filter = input.value;
        invalidateUI();
      }
    },

    onSelect: (event) => {
      const input = event.target as HTMLTextAreaElement;
      if (input.id !== 'notes-editor') return;
      const n = input.selectionEnd - input.selectionStart;
      state.noteSelection =
        n > 0
          ? {
              meetingId: state.meetingId,
              start: input.selectionStart,
              end: input.selectionEnd,
              quote: input.value.slice(input.selectionStart, input.selectionEnd),
            }
          : undefined;
      if (state.selectionLength !== n) {
        state.selectionLength = n;
        invalidateUI();
      }
    },
  };
}

export function bindShortcuts(
  host: UiRuntime,
  workspace: import('./workspace').WorkspaceController,
  actions: Controllers['actions']
) {
  const { state, safe, toast } = host;
  document.addEventListener(
    'keydown',
    safe(async (e) => {
      if (state.view === 'setup') {
        if ((e.ctrlKey || e.metaKey) && ['k', 's', 'n', 'o', 'p'].includes(e.key.toLowerCase()))
          e.preventDefault();
        return;
      }
      if (
        state.view === 'workspace' &&
        !$<HTMLDialogElement>('#modal').open &&
        !$('#search-palette') &&
        actionShortcut(e, 'm')
      ) {
        e.preventDefault();
        if (!e.repeat) await actions['add-annotation']();
        return;
      }
      if (
        state.view === 'project' &&
        !$<HTMLDialogElement>('#modal').open &&
        !$('#search-palette') &&
        !e.repeat &&
        (actionShortcut(e, 'm') || actionShortcut(e, 'i'))
      ) {
        e.preventDefault();
        await actions[actionShortcut(e, 'm') ? 'project-live' : 'project-import']();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        await workspace.saveNotes();
        toast('紀錄已儲存');
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        await actions.search();
      }
    })
  );
}
