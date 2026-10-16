import type { ReactNode } from 'react';
import { isInputState } from '../../domain/agents/input-state';
import { rebaseAnnotations } from '../../domain/annotations';
import type { Invoke } from '../../domain/ipc';
import type { Meeting, UiState } from '../../domain/models';
import { sessionApi } from '../agent/session/api';
import type { AudioCapture } from '../audio/capture';
import { notify } from '../layout/notifications';
import { renderNodeInto } from '../layout/roots';
import { createSetupGate } from '../setup/gate';
import { DialogContents, NamePrompt } from './integration/dialogs';

export function $<T extends Element = HTMLInputElement>(
  selector: string,
  root: ParentNode = document
): T {
  return root.querySelector<T>(selector);
}

export function $$<T extends Element = HTMLInputElement>(
  selector: string,
  root: ParentNode = document
): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

export const api: Invoke = (name, ...args) => window.studio.invoke(name, ...args);

let modalSequence = 0;

export function createRuntime(render: () => void, startSetup: () => void) {
  const state: UiState = {
    projects: [],
    meetings: [],
    settings: null,
    view: 'overview',
    projectId: null,
    meetingId: null,
    source: 'mic',
    microphoneId: localStorage.getItem('studio.microphone') || '',
    inputDevices: [],
    audioSourceMode: 'device',
    recordOnly: false,
    sourceTab: 'transcript',
    editorTab: 'edit',
    settingsTab: 'asr',
    selectedFiles: [],
    audioJobs: [],
    audioDenoise: localStorage.getItem('studio.audio-denoise') !== 'false',
    skills: [],
    filter: '',
    statusFilter: '',
    proposal: null,
    runId: null,
    agentEvents: [],
    dirty: false,
    saveTimer: null,
    sidebarCollapsed: false,
    setupLocked: true,
  };
  const refreshSetupGate = createSetupGate(state, api);

  const requireSetup = () => {
    if (!state.setupLocked) return false;
    if (state.view !== 'setup') startSetup();
    return true;
  };

  const project = () => state.projects.find((p) => p.id === state.projectId);

  const current = () => state.meetings.find((m) => m.id === state.meetingId);

  const toast = notify;

  function updateMeeting(m: Meeting) {
    const i = state.meetings.findIndex((x) => x.id === m.id);
    if (i >= 0 && state.annotationDrafts?.[m.id])
      state.annotationDrafts[m.id] = rebaseAnnotations(
        state.annotationDrafts[m.id],
        state.meetings[i].notes,
        m.notes
      );
    if (i >= 0) state.meetings[i] = m;
    else state.meetings.unshift(m);
  }

  function applyTheme(theme: string) {
    const resolvedTheme = () => {
      if (theme === 'system') {
        if (matchMedia('(prefers-color-scheme: dark)').matches) {
          return 'dark';
        }
        return 'light';
      }
      return theme;
    };

    document.documentElement.dataset.theme = resolvedTheme();
  }

  function applyInputState(input: unknown) {
    if (!isInputState(input)) throw new Error('Agent 佇列狀態格式無效');
    state.runId = input.activeRunId;
    state.agentQueue = input.queued;
    state.queuePaused = input.paused;
  }

  function safe<E>(fn: (event: E) => unknown | Promise<unknown>) {
    return async (e: E) => {
      try {
        await fn(e);
      } catch (caughtErr) {
        const err = caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));

        toast(err.message || String(err), true);
      }
    };
  }

  function showModal(title: ReactNode, body: ReactNode, footer: ReactNode = null) {
    const modal = $('#modal') as HTMLDialogElement;
    if (modal.open) modal.close();
    modal.className = '';
    modal.oncancel = null;
    modal.onclose = null;
    modal.onkeydown = null;
    renderNodeInto(
      modal,
      <DialogContents
        key={++modalSequence}
        title={title}
        footer={footer}
        close={() => modal.close()}
      >
        {body}
      </DialogContents>
    );
    modal.showModal();
    modal.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return modal;
  }

  function askName(title: string, label: string, defaultValue = '') {
    return new Promise<string | null>((resolve) => {
      const modal = showModal(title, null);
      let finished = false;

      const finish = (value: string | null) => {
        if (finished) return;
        finished = true;
        modal.close();
        resolve(value);
      };

      renderNodeInto(
        modal,
        <NamePrompt
          key={++modalSequence}
          modal={modal}
          title={title}
          label={label}
          initial={defaultValue}
          finish={finish}
        />
      );
    });
  }

  return {
    state,
    capture: null as AudioCapture,
    api: sessionApi(state, api),
    project,
    current,
    toast,
    updateMeeting,
    applyTheme,
    applyInputState,
    safe,
    showModal,
    askName,
    render,
    startSetup,
    refreshSetupGate,
    requireSetup,
  };
}

export type UiRuntime = ReturnType<typeof createRuntime>;
