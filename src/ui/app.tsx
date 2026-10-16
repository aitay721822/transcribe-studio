import { createAgentController } from './agent/controller';
import { createAnnotationController } from './application/annotations/controller';
import { applicationEvents, bindShortcuts } from './application/bindings';
import { createDiagnosticController } from './application/diagnostics/controller';
import { createCommands } from './application/integration/commands';
import { createProjectController } from './application/projects';
import { $, createRuntime } from './application/runtime';
import { createSettingsController } from './application/settings';
import { createWorkspaceController } from './application/workspace';
import { AudioCapture } from './audio/capture';
import { createAudioController } from './audio/controller';
import { closeDropdown } from './components/dropdown';
import { Reveal } from './components/motion/reveal';
import { createViews } from './components/views';
import { invalidateUI, renderNodeInto } from './layout/roots';
import { renderShell, type ShellContent } from './layout/shell';
import { Button } from './primitives/button';
import { closeProjectMenu } from './projects/menu';
import { SetupWizard } from './setup/wizard';

const host = createRuntime(render, startSetup);
const { state, api, toast, updateMeeting, applyTheme, applyInputState, showModal, safe } = host;
const workspace = createWorkspaceController(host);
const projects = createProjectController(host, workspace);
const settings = createSettingsController(host);
const audio = createAudioController(host, workspace, projects);
const agent = createAgentController(host, workspace);
const annotations = createAnnotationController(host, workspace);
const diagnostics = createDiagnosticController(host);
const controllers = {
  workspace,
  projects,
  settings,
  audio,
  agent,
  annotations,
  diagnostics,
};
const actions = createCommands(host, controllers);
const { saveNotes, loadWorkspace } = workspace;
const { refreshAudioDevices, stopRecording, seekAudio } = audio;
const { updateAgentFeed } = agent;
let setupSession = 0;
let setupProps: import('./setup/wizard').SetupProps;

function startSetup() {
  setupSession++;
  setupProps = {
    settings: state.settings,
    host: {
      api,

      test: (settings, kind) => diagnostics.open(settings, kind),

      saved: async (settings) => {
        state.settings = settings;
        applyTheme(settings.theme);
        await host.refreshSetupGate(settings);
      },

      finish: async () => {
        if (!(await host.refreshSetupGate()))
          throw new Error('請先完成語音辨識與 Agent 的必要設定');
        await loadWorkspace();
        state.view = state.projectId ? 'project' : 'overview';
        render();
        toast('設定完成');
      },
    },
  };
  state.view = 'setup';
  render();
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings?.theme === 'system') applyTheme('system');
});
const events = applicationEvents(host, {
  ...controllers,
  actions,
});

function render() {
  closeProjectMenu();
  closeDropdown();
  renderShell(buildContent);
}

function buildContent(): ShellContent {
  if (state.view === 'setup')
    return {
      standalone: 'setup' as const,
      title: null,
      sidebar: null,
      main: <SetupWizard key={setupSession} {...setupProps} />,
      events,
    };
  const {
    sidebar,
    titlebar,
    topbar,
    overview,
    livePage,
    importPage,
    meetingsPage,
    projectPage,
    workspacePage,
    settingsPage,
  } = createViews(state, host.capture);
  const views: Record<string, () => import('react').ReactNode> = {
    overview,
    live: livePage,
    import: importPage,
    meetings: meetingsPage,
    project: projectPage,
    workspace: workspacePage,
    settings: settingsPage,

    setup: () => <SetupWizard key={setupSession} {...setupProps} />,
  };
  return {
    standalone: state.view === 'settings' ? ('settings' as const) : undefined,
    title: titlebar(),
    sidebar: sidebar(),
    main: (
      <main className="main">
        {topbar()}
        <Reveal
          className="motion-view"
          distance={0}
          key={`${state.view}:${state.view === 'workspace' ? state.meetingId : state.settingsTab}`}
        >
          {views[state.view]()}
        </Reveal>
      </main>
    ),
    events,
  };
}

bindShortcuts(host, workspace, actions);

async function init() {
  if (!window.studio) {
    renderNodeInto(
      $('#app'),
      <div className="empty">
        <h3>請使用 Electron 開啟 Transcribe Studio</h3>
        <p>在專案目錄執行 npm start。</p>
      </div>
    );
    return;
  }
  const data = await api('bootstrap');
  Object.assign(state, data);
  document.documentElement.dataset.platform = data.platform;
  state.projectId = state.projects.find((p) => !p.archivedAt)?.id || null;
  applyTheme(state.settings.theme);
  host.capture = new AudioCapture(api, (ev) => {
    if (ev.type === 'warning') toast(ev.message);
    if (ev.type === 'error') {
      toast(ev.message, true);
      invalidateUI();
    }
    if (ev.type === 'source-ended') {
      toast(ev.message);
      stopRecording().catch((e) => toast(e.message, true));
    }
  });
  await refreshAudioDevices();
  navigator.mediaDevices.addEventListener('devicechange', () =>
    refreshAudioDevices().catch(() => {})
  );
  window.studio.on('asr:event', (ev) => {
    if (ev.type === 'segment') {
      const m = state.meetings.find((m) => m.id === ev.meetingId);
      if (!m) return;
      const i = m.segments.findIndex((s) => s.id === ev.segment.id);
      if (i >= 0) m.segments[i] = ev.segment;
      else m.segments.push(ev.segment);
      if (
        state.view === 'workspace' &&
        state.meetingId === ev.meetingId &&
        state.sourceTab === 'transcript'
      ) {
        const body = $('#source-body');
        const bottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        renderShell(buildContent);
        if (bottom) body.scrollTop = body.scrollHeight;
      }
    }
    if (ev.type === 'error') toast(ev.message, true);
    if (ev.type === 'closed' && !host.capture.stopping && host.capture.active) {
      host.capture.asrActive = false;
      invalidateUI();
      toast(ev.message, true);
    }
  });
  window.studio.on('agent:event', (ev) => {
    if ((ev.sessionId || undefined) !== state.temporaryChat?.id) return;
    if (ev.type === 'approval-decision') {
      state.agentEvents = state.agentEvents.filter((e) => e.id !== ev.id);
      updateAgentFeed();
      return;
    }
    if (ev.type === 'session') return;
    if (ev.meetingId !== state.meetingId) return;
    if (ev.type === 'input-state') {
      applyInputState(ev.args);
      updateAgentFeed();
      return;
    }
    if (ev.type === 'started') state.runId = ev.runId;
    if (ev.type === 'proposal') {
      state.proposal = {
        notes: ev.notes,
        version: ev.version,
        annotationIds: ev.annotationIds,
        annotationScope: ev.annotationScope,
      };
      state.runId = null;
    }
    if (ev.type === 'error' || ev.type === 'context-completed' || ev.type === 'answer')
      state.runId = null;
    state.agentEvents.push(ev);
    updateAgentFeed();
  });
  window.studio.on('meeting:event', (m) => {
    updateMeeting(m);
    if (state.view === 'import') render();
  });
  window.studio.on('audio:progress', (job) => {
    state.audioJobs = [job, ...(state.audioJobs || []).filter((item) => item.id !== job.id)].slice(
      0,
      20
    );
    invalidateUI();
  });
  state.audioJobs = await api('audio:jobs');
  window.studio.on('app:close-request', async () => {
    const close = async () => {
      await saveNotes();
      if (state.runId && state.runId !== 'pending') await api('agent:cancel', state.runId);
      await api('window:control', 'close-confirmed');
    };

    if (!host.capture.active) {
      await close().catch((e) => toast(e.message, true));
      return;
    }
    const modal = showModal(
      '會議正在錄音',
      <p>結束並儲存目前錄音後，再關閉視窗。</p>,
      <Button
        variant="default"
        className="btn primary"
        id="finish-close"
        onClick={safe(async () => {
          await stopRecording();
          modal.close();
          await close();
        })}
      >
        儲存並關閉
      </Button>
    );
  });
  if (!(await host.refreshSetupGate())) startSetup();
  else {
    await loadWorkspace();
    render();
  }
}

init().catch((e) => {
  renderNodeInto(
    $('#app'),
    <div className="empty">
      <h3>啟動失敗</h3>
      <p>{e.message}</p>
    </div>
  );
});
