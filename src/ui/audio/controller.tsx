import type { ProjectController } from '../application/projects';
import { $, $$, type UiRuntime } from '../application/runtime';
import type { WorkspaceController } from '../application/workspace';
import { duration } from '../components/display';
import { listInputDevices } from './sources';
import { AudioMeter } from './testing/meter-dialog';

export function createAudioController(
  host: UiRuntime,
  workspace: WorkspaceController,
  projects: ProjectController
) {
  const { state, api, project, current, toast, updateMeeting, showModal, askName, render } = host;
  const { saveNotes, openMeeting } = workspace;
  const { createProject } = projects;

  async function newMeeting() {
    if (host.capture.active || host.capture.starting) {
      await openMeeting(host.capture.id);
      toast('請先結束目前的錄音');
      return;
    }
    if (project()?.archivedAt)
      state.projectId = state.projects.find((p) => !p.archivedAt)?.id || null;
    if (!project()) {
      await createProject();
      if (!project()) return;
    }
    const title = await askName(
      '新增會議',
      `專案：${project().name}`,
      `會議 ${new Date().toLocaleDateString('zh-TW')}`
    );
    if (!title) return;
    const m = await api('meeting:create', state.projectId, title, 'live');
    updateMeeting(m);
    await openMeeting(m.id);
    await startRecording();
  }

  async function startRecording() {
    if (host.capture.active) {
      toast('請先結束目前的錄音');
      return;
    }
    if (state.runId) throw new Error('請先停止 Agent 再開始錄音');
    const m = current();
    if (!m) return;
    const button = $('[data-action="start-recording"]');
    if (button) button.disabled = true;
    await saveNotes();
    await host.capture.start(
      m.id,
      state.source,
      state.recordOnly,
      state.settings.asr,
      m.duration,
      state.microphoneId
    );
    updateMeeting(await api('meeting:get', m.id));
    render();
  }

  async function stopRecording() {
    await saveNotes();
    const m = await host.capture.stop();
    if (m) updateMeeting(m);
    render();
    toast('錄音已儲存');
  }

  async function testAudio() {
    if (host.capture.active) throw new Error('錄音期間不能啟動音量測試');
    showModal(
      '測試音訊來源',
      <AudioMeter
        source={state.source}
        deviceId={state.microphoneId}
        ready={() => refreshAudioDevices()}
      />
    );
  }

  async function refreshAudioDevices(requestPermission = false) {
    state.inputDevices = await listInputDevices(requestPermission);
    if (state.microphoneId && !state.inputDevices.some((d) => d.id === state.microphoneId)) {
      state.microphoneId = '';
      localStorage.removeItem('studio.microphone');
    }
    if (state.view === 'live' && !host.capture.active) render();
  }

  async function seekAudio(time: number, recordingId?: string) {
    await saveNotes();
    const m = current();
    const record =
      m.recordings.find((r) => r.id === recordingId) ||
      m.recordings.find(
        (r) => time >= (r.offset || 0) && time <= (r.offset || 0) + (r.duration || m.duration)
      );
    if (!record) {
      toast('此片段沒有可播放的音訊');
      return;
    }
    if (!record.complete) {
      toast('錄音完成後即可播放此片段');
      return;
    }
    state.sourceTab = 'audio';
    render();
    const audio = $<HTMLAudioElement>(`[data-audio-id="${record.id}"]`);
    if (audio.readyState < 1)
      await new Promise<void>((resolve) =>
        audio.addEventListener('loadedmetadata', () => resolve(), {
          once: true,
        })
      );
    $$<HTMLAudioElement>('.audio-player').forEach((a) => {
      if (a !== audio) a.pause();
    });
    audio.currentTime = Math.max(0, time - (record.offset || 0));
    await audio.play();
  }

  async function pickFiles() {
    state.selectedFiles.push(...(await api('file:pick', state.view === 'live' ? 'audio' : 'all')));
    render();
  }

  async function transcribeFiles() {
    if (!state.projectId) throw new Error('請先建立專案');
    if (!state.selectedFiles.length) throw new Error('請先選擇檔案');
    const projectId = state.projectId;
    const denoise = state.audioDenoise !== false;
    const files = state.selectedFiles.splice(0);
    render();
    for (const f of files) {
      toast(`正在處理 ${f.name}`);
      try {
        updateMeeting(await api('file:transcribe', projectId, f.id, { denoise }));
        toast(`${f.name} 已完成`);
      } catch (caughtE) {
        const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

        toast(e.message, true);
      }
    }
    render();
  }

  async function pauseRecording() {
    await saveNotes();
    await host.capture.togglePause();
    render();
  }

  async function addMarker() {
    await saveNotes();
    const m = current();
    m.markers.push({
      time: host.capture.elapsed(),
      label: '會議重點',
    });
    updateMeeting(
      await api('meeting:update', m.id, {
        markers: m.markers,
      })
    );
    toast(`已標記 ${duration(host.capture.elapsed())}`);
  }

  return {
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
  };
}

export type AudioController = ReturnType<typeof createAudioController>;
