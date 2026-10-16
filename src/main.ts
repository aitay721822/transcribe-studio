import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { app, dialog, ipcMain, nativeImage, net, protocol } from 'electron';
import { registerAgent } from './desktop/agent-routes';
import { registerCaptureLifecycle } from './desktop/asr/lifecycle';
import { legacyAudioJob, registerAsrTasks } from './desktop/asr/tasks';
import type { ActiveRecording, DesktopContext } from './desktop/context';
import { registerDiagnostics } from './desktop/diagnostics/routes';
import { registerAsr } from './desktop/ipc/asr';
import { registerAudio } from './desktop/ipc/audio';
import { registerImports } from './desktop/ipc/imports';
import { registerMeetings } from './desktop/ipc/meetings';
import { registerProjects } from './desktop/ipc/projects';
import { CredentialStartupCancelled, openCredentialVault } from './desktop/platform/credentials';
import { createSettings, registerSettings } from './desktop/settings';
import { createWindow, registerWindow } from './desktop/window';
import type { SpeechSession } from './domain/asr/config';
import type { IpcCommands } from './domain/ipc';
import type { Settings } from './domain/models';
import { errorMessage } from './domain/value';
import { Agent } from './harness/coordinator';
import { Store } from './persistence/store';
import { ImageVault } from './services/agents/conversation/images';
import { prepareRuntimePath } from './services/agents/posix';
import { AsrTaskService } from './services/asr/tasks';
import { credentialRedactor } from './services/security/redaction';
import type { SettingsVault } from './services/security/settings';
import { closeWorkspace, inside } from './services/workspace/files';

if (process.platform === 'win32') app.setAppUserModelId('studio.transcribe.desktop');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'studio-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
if (process.env.STUDIO_TEST_DATA)
  app.setPath('userData', path.resolve(process.env.STUDIO_TEST_DATA));
let win: BrowserWindow,
  store: Store,
  agent: Agent,
  closing = false,
  runtimeClosed = false;
let diagnostics: ReturnType<typeof registerDiagnostics>;
let audioImports: ReturnType<typeof registerImports>;
let temporary: ReturnType<typeof registerAgent>;
let vault: SettingsVault;
let asrTasks: AsrTaskService;

let settingsSnapshot: () => Partial<Settings> = () => ({});

const recordings = new Map<string, ActiveRecording>();
const asr = new Map<string, SpeechSession>();

function send(channel: string, data: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function handle<K extends keyof IpcCommands>(
  name: K,
  fn: (...args: Parameters<IpcCommands[K]>) => ReturnType<IpcCommands[K]>
) {
  ipcMain.handle(name, async (event, ...args: unknown[]) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('IPC 來源未授權');
    try {
      return await fn(...(args as Parameters<IpcCommands[K]>));
    } catch (error) {
      let saved: Partial<Settings> = {};
      try {
        saved = settingsSnapshot();
      } catch {
        // A locked keychain must not hide the original, safe credential-storage error.
      }
      throw new Error(credentialRedactor(saved, process.env, args).text(errorMessage(error)));
    }
  });
}

app
  .whenReady()
  .then(async () => {
    const dataDir = app.getPath('userData');
    await prepareRuntimePath();
    await fsp.mkdir(path.join(dataDir, 'audio'), { recursive: true });
    store = new Store(path.join(dataDir, 'studio.sqlite'));
    vault = await openCredentialVault(store, dataDir);
    store.recover();
    const settings = createSettings(vault, () => win);
    settingsSnapshot = settings.settingsInternal;
    const images = new ImageVault(path.join(dataDir, 'attachments'), (bytes) => {
      let image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('圖片格式無法讀取，請使用 PNG、JPEG 或 WebP');
      const size = image.getSize();
      if (size.width * size.height > 40000000) throw new Error('圖片像素過大，請先縮小');
      if (Math.max(size.width, size.height) > 2400)
        image = image.resize(size.width >= size.height ? { width: 2400 } : { height: 2400 });
      return { bytes: image.toPNG(), ...image.getSize() };
    });
    agent = new Agent(
      {
        get: store.get.bind(store),

        meetings: () => store.meetings(),

        conversations: store.conversations,
        settings: settings.settingsInternal,

        saveRun: (run) => store.saveRun(run),

        queuedRuns: () => store.list('runs').filter((run) => run.status === 'queued'),

        updateMeeting: (id, patch) => store.updateMeeting(id, patch),
      },
      path.join(__dirname, '..', 'skills'),
      (event) => send('agent:event', event),
      path.join(dataDir, 'runtime'),
      undefined,
      images
    );
    protocol.handle('studio-media', async (request) => {
      const url = new URL(request.url);
      if (url.hostname === 'image') {
        const [meetingId, imageId] = url.pathname.slice(1).split('/');
        try {
          return new Response(new Uint8Array(await images.bytes(meetingId, imageId)), {
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
          });
        } catch {
          return new Response('', { status: 404 });
        }
      }
      const id = new URL(request.url).pathname.slice(1);
      const recording = store
        .meetings()
        .flatMap((m) => m.recordings)
        .find((r) => r.id === id);
      if (!recording || !inside(path.join(dataDir, 'audio'), recording.path))
        return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(recording.path).toString(), { headers: request.headers });
    });
    settings.applyWindowTheme(settings.settingsPublic().theme);
    win = createWindow(path.join(__dirname, 'transport', 'preload.cjs'));
    asrTasks = new AsrTaskService({
      store,
      directory: path.join(dataDir, 'asr-spool'),

      settings: () => settings.settingsInternal().asr,

      changed: (meetingId, task) => {
        if (task) {
          send('audio:progress', legacyAudioJob(task));
          if (task.source === 'import' && store.get('meetings', task.meetingId)) {
            let status = 'transcribing';
            if (task.state === 'completed') status = 'completed';
            if (['cancelled', 'paused', 'needs_attention'].includes(task.state))
              status = 'interrupted';
            if (store.get('meetings', task.meetingId).status !== status)
              store.updateMeeting(task.meetingId, { status });
          }
        }
        send('asr:tasks-changed', { meetingId });
        const meeting = meetingId ? store.get('meetings', meetingId) : undefined;
        if (meeting) send('meeting:event', settings.sanitizeMeeting(meeting));
      },
    });
    const ctx: DesktopContext = {
      handle,
      win,
      store,
      agent,
      images,
      dataDir,
      bundledSkills: path.join(__dirname, '..', 'skills'),
      asr,
      asrTasks,
      recordings,
      imports: new Map(),
      rtcCaches: new Map(),

      meeting: (id: string) => {
        const meeting = store.get('meetings', id);
        if (!meeting) throw new Error('找不到會議');
        return meeting;
      },

      setClosing: () => {
        closing = true;
      },

      ...settings,
      send,
    };
    diagnostics = registerDiagnostics(ctx);
    audioImports = registerImports(ctx);
    for (const register of [
      registerProjects,
      registerMeetings,
      registerAudio,
      registerAsr,
      registerAsrTasks,
      registerSettings,
      registerWindow,
    ])
      register(ctx);
    temporary = registerAgent(ctx);
    registerCaptureLifecycle(ctx);
    await asrTasks.start();
    win.webContents.on('did-start-loading', () => {
      void temporary.close();
    });
    win.webContents.on('render-process-gone', () => {
      void temporary.close();
    });
    await win.loadFile(path.join(__dirname, 'ui', 'index.html'));
    win.show();
    win.on('close', (event) => {
      if (!closing) {
        event.preventDefault();
        send('app:close-request', {});
      }
    });
    if (process.env.STUDIO_SMOKE_TEST) setTimeout(() => app.quit(), 2000);
  })
  .catch((error: unknown) => {
    if (error instanceof CredentialStartupCancelled) {
      app.quit();
      return;
    }
    dialog.showErrorBox(
      '無法開啟 Transcribe Studio',
      credentialRedactor().text(errorMessage(error))
    );
    app.quit();
  });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (runtimeClosed) return;
  event.preventDefault();
  runtimeClosed = true;
  closing = true;
  for (const [id, recording] of recordings) {
    try {
      fs.fsyncSync(recording.fd);
    } catch {
      /* Recovery retains the readable prefix. */
    } finally {
      fs.closeSync(recording.fd);
      recordings.delete(id);
    }
  }
  for (const session of asr.values()) {
    session.cancel?.();
    session.ws?.terminate();
  }
  Promise.allSettled([
    ...[...asr.values()].map((session) => session.close()),
    agent?.close(),
    temporary?.close(),
    diagnostics?.close(),
    audioImports?.close(),
    asrTasks?.close(),
    closeWorkspace(),
    vault?.flush(),
  ]).finally(() => app.quit());
});
app.on('quit', () => store?.close());
