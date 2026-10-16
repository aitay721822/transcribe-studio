import { contextBridge, ipcRenderer } from 'electron';
import type { IpcEvents } from '../domain/ipc';
import type { StudioBridge } from '../domain/models';

const allowed = new Set([
  'bootstrap',
  'project:create',
  'project:rename',
  'project:archive',
  'project:delete',
  'project:folders',
  'project:remove-root',
  'project:edit-begin',
  'project:edit-end',
  'project:pick-folders',
  'project:edit-save',
  'project:organize',
  'project:open-folder',
  'workspace:list',
  'workspace:mentions',
  'workspace:mention-cancel',
  'workspace:mention-release',
  'workspace:resolve-reference',
  'workspace:read',
  'workspace:read-page',
  'workspace:release',
  'skills:list',
  'meeting:create',
  'meeting:get',
  'meeting:delete',
  'meeting:update',
  'meeting:revisions',
  'settings:save',
  'agents:detect',
  'connection:asr-start',
  'connection:asr-audio',
  'connection:asr-commit',
  'connection:rtc-signal',
  'connection:rtc-event',
  'connection:agent-test',
  'connection:stop',
  'window:control',
  'clipboard:write',
  'audio:start',
  'audio:chunk',
  'audio:finish',
  'audio:jobs',
  'audio:cancel',
  'asr:start',
  'asr:audio',
  'asr:commit',
  'asr:stop',
  'rtc:signal',
  'rtc:event',
  'file:pick',
  'file:transcribe',
  'recording:transcribe',
  'agent:run',
  'agent:submit',
  'agent:promote',
  'agent:temporary-begin',
  'agent:temporary-end',
  'agent:temporary-annotations',
  'agent:temporary-apply',
  'agent:image-add',
  'agent:image-release',
  'agent:input-state',
  'agent:trace',
  'agent:command',
  'agent:resume',
  'agent:cancel',
  'agent:approve',
  'export:docx',
]);
const events = new Set([
  'asr:event',
  'agent:event',
  'meeting:event',
  'audio:progress',
  'app:close-request',
  'connection:event',
]);
const bridge: StudioBridge = {
  invoke: (name, ...args) => {
    if (!allowed.has(name)) throw new Error('未知的操作');
    return ipcRenderer.invoke(name, ...args);
  },

  on: <K extends keyof IpcEvents>(name: K, callback: (value: IpcEvents[K]) => void) => {
    if (!events.has(name)) throw new Error('未知的事件');

    const listener = (_event: import('electron').IpcRendererEvent, value: IpcEvents[K]) =>
      callback(value);

    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
};
contextBridge.exposeInMainWorld('studio', bridge);
