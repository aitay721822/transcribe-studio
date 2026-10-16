import type { BrowserWindow } from 'electron';
import type { SpeechSession } from '../domain/asr/config';
import type { Handle, IpcEvents } from '../domain/ipc';
import type { Meeting, TranscriptSegment } from '../domain/models';
import type { Agent } from '../harness/coordinator';
import type { Store } from '../persistence/store';
import type { ImageVault } from '../services/agents/conversation/images';
import type { AsrTaskService } from '../services/asr/tasks';
import type { createSettings } from './settings';

export interface ActiveRecording {
  id: string;
  meetingId: string;
  fd: number;
  path: string;
  bytes: number;
  startedAt: string;
  offset: number;
}
export interface DesktopContext extends ReturnType<typeof createSettings> {
  handle: Handle;
  win: BrowserWindow;
  store: Store;
  agent: Agent;
  images: ImageVault;
  dataDir: string;
  bundledSkills: string;
  asr: Map<string, SpeechSession>;
  asrTasks: AsrTaskService;
  recordings: Map<string, ActiveRecording>;
  imports: Map<string, string>;
  rtcCaches: Map<string, Map<string, TranscriptSegment>>;
  meeting(id: string): Meeting;
  setClosing(): void;
  send<K extends keyof IpcEvents>(channel: K, value: IpcEvents[K]): void;
}
