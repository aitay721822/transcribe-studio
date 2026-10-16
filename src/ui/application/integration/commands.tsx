import { errorMessage } from '../../../domain/value';
import { closeDropdown } from '../../components/dropdown';
import { toggleSidebar } from '../../layout/shell';
import { openProjectFiles } from '../../projects/files';
import { closeProjectMenu } from '../../projects/menu';
import { openSearchPalette } from '../../search/palette';
import { $, type UiRuntime } from '../runtime';
import type { ControllerSet } from './contracts';

export function createCommands(host: UiRuntime, controllers: ControllerSet) {
  const { workspace, projects, audio, agent, settings } = controllers;
  const {
    state,
    api,
    project,
    current,
    toast,
    updateMeeting,
    applyTheme,
    applyInputState,
    showModal,
    safe,
    render,
    startSetup,
  } = host;
  const {
    saveNotes,
    navigate,
    loadWorkspace,
    openMeeting,
    deleteMeeting,
    revisions,
    exportDocument,
  } = workspace;
  const {
    editProject,
    activateProject,
    projectCommand,
    createProject,
    archiveProject,
    deleteProject,
  } = projects;
  const {
    newMeeting,
    startRecording,
    stopRecording,
    testAudio,
    refreshAudioDevices,
    seekAudio,
    pickFiles,
    transcribeFiles,
    pauseRecording,
    addMarker,
  } = audio;
  const { runAgent, updateAgentFeed, reviewProposal } = agent;
  const { collectSettings, saveSettings, toggleTheme } = settings;

  const testSpeech = (provider: string) => {
    const draft = collectSettings();
    draft.asr.provider = provider;
    controllers.diagnostics.open(draft, 'asr');
  };

  const commands = {
    'test-offline-connection': () => testSpeech('transcriptions'),

    'test-realtime-connection': () => testSpeech('openai'),

    'test-asr-connection': () =>
      controllers.diagnostics.open(
        state.view === 'settings' ? collectSettings() : state.settings,
        'asr'
      ),

    'test-agent-connection': () => controllers.diagnostics.open(collectSettings(), 'agent'),

    'add-annotation': () => controllers.annotations.stage(),

    'revise-annotations': () => controllers.annotations.stagePending(),

    'back-workspace': () => {
      const workspaceDestination = () => {
        if (state.meetingId) {
          return 'workspace';
        }
        if (state.projectId) {
          return 'project';
        }
        return 'overview';
      };

      return navigate(workspaceDestination());
    },

    'archive-project': archiveProject,
    'delete-project': deleteProject,

    'refresh-devices': () => refreshAudioDevices(true),

    'collapse-sidebar': async () => {
      await saveNotes();
      toggleSidebar();
    },

    'new-project': createProject,
    'new-meeting': newMeeting,

    'go-live': () => navigate('live'),

    'go-import': () => navigate('import'),

    'go-settings': () => navigate('settings'),

    'go-meetings': () => navigate('meetings'),

    'project-live': async () => {
      if (!project() || project().archivedAt) throw new Error('請先選擇未封存的專案');
      state.audioSourceMode = 'device';
      await navigate('live');
    },

    'project-import': async () => {
      if (!project() || project().archivedAt) throw new Error('請先選擇未封存的專案');
      await navigate('import');
    },

    search: async () => {
      if ($<HTMLDialogElement>('#modal').open) return;
      closeDropdown();
      closeProjectMenu();
      openSearchPalette({
        meetings: state.meetings,
        projects: state.projects,
        openMeeting,

        quickAction: async (action) => {
          if (action === 'new-meeting') await newMeeting();
          else if (action === 'add-folder') await editProject();
          else {
            if (!project()) await createProject();
            if (!project()) return;
            const projectId = state.projectId;
            await openProjectFiles({
              showModal,

              list: (query, cursor) => api('workspace:list', projectId, query, { cursor }),

              read: (rootId, relative, options) =>
                api('workspace:read-page', projectId, rootId, relative, options),

              release: (cursor) => api('workspace:release', cursor),
            });
          }
        },

        onError: (error: unknown) => toast(errorMessage(error), true),
      });
    },

    'toggle-theme': toggleTheme,

    'add-folder': async () => {
      await editProject();
    },

    'rename-project': async () => {
      await editProject();
    },

    'pick-files': pickFiles,
    'transcribe-files': transcribeFiles,
    'start-recording': startRecording,
    'stop-recording': stopRecording,
    'pause-recording': pauseRecording,
    'add-marker': addMarker,
    'test-audio': testAudio,

    'save-notes': async () => {
      await saveNotes();
      toast('紀錄已儲存');
    },

    'run-agent': runAgent,

    'queue-agent': () => runAgent('queue'),

    'steer-agent': () => runAgent('steer'),

    'resume-agent': async () => {
      applyInputState(await api('agent:resume', state.meetingId));
      updateAgentFeed();
    },

    setup: startSetup,

    'cancel-agent': async () => {
      if (state.runId && state.runId !== 'pending') await api('agent:cancel', state.runId);
    },

    'review-proposal': reviewProposal,
    revisions,
    'save-settings': saveSettings,
    export: exportDocument,
  };
  return Object.fromEntries(
    Object.entries(commands).map(([name, action]) => [
      name,
      () => {
        if (state.view === 'setup' || host.requireSetup()) return;
        return action();
      },
    ])
  );
}
