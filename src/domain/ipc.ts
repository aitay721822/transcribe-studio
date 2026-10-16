import type { Agent } from '../harness/coordinator';
import type { Revision } from '../persistence/store';
import type { DetectedAgent } from '../services/agents/detection';
import type { NoteAnnotation } from './annotations';
import type { AsrEvent } from './asr/config';
import type { AsrConnectionStatus, ConnectionAction } from './asr/connection';
import type { AudioJob } from './asr/file-progress';
import type { FailureInfo } from './asr/retry';
import type { ChunkRange, TaskAction, TaskFilter, TaskPage } from './asr/tasks';
import type { PlaybackDevice, PlaybackEvent } from './audio-devices';
import type {
  AgentEvent,
  AgentRequest,
  AgentRun,
  ContextReference,
  ImageAttachment,
  LlmSettings,
  Meeting,
  Project,
  Settings,
  Skill,
  WorkspaceRoot,
} from './models';
import type { MediaPermissions } from './platform';
import type { FileList, FilePage, WorkspaceOptions } from './workspace';

export interface ConnectionEvent extends AsrEvent {
  id?: string;
  label?: string;
  sampleRate?: number;
  channelCount?: number;
  connected?: boolean;
}
export interface SpeechConnection {
  provider: string;
  sampleRate: number;
  chunkSeconds?: number;
  channel?: string;
  iceServers?: RTCIceServer[];
}
export type InputState = ReturnType<Agent['inputState']>;
type Removal = { warnings: string[] };
type AudioOptions = { denoise?: boolean; start?: number; end?: number; replace?: boolean };
type PickedFile = { id: string; name: string; size: number };
export interface IpcCommands {
  bootstrap: () => {
    projects: Project[];
    meetings: Meeting[];
    settings: Settings;
    platform: string;
  };
  'project:create': (name: string) => Project;
  'project:rename': (id: string, name: string) => Project;
  'project:archive': (id: string, archived: boolean) => Project;
  'project:delete': (id: string) => Promise<Removal>;
  'project:folders': (id: string) => Promise<Project>;
  'project:remove-root': (id: string, rootId: string) => Project;
  'project:edit-begin': (id: string) => string;
  'project:edit-end': (token: string) => void;
  'project:pick-folders': (token: string) => Promise<WorkspaceRoot[]>;
  'project:edit-save': (token: string, name: string, roots: string[]) => Project;
  'project:organize': (id: string, patch: { pinned?: boolean; section?: string }) => Project;
  'project:open-folder': (id: string, rootId?: string) => Promise<void>;
  'workspace:list': (id: string, query?: string, options?: WorkspaceOptions) => Promise<FileList>;
  'workspace:mentions': (
    id: string,
    query: string,
    job: string,
    cursor?: string
  ) => Promise<FileList>;
  'workspace:mention-cancel': (id: string) => boolean;
  'workspace:mention-release': (cursor: string) => boolean;
  'workspace:resolve-reference': (
    id: string,
    rootId: string,
    relative: string
  ) => Promise<Exclude<ContextReference, { kind: 'search' }>>;
  'workspace:read': (id: string, rootId: string, relative: string) => Promise<string>;
  'workspace:read-page': (
    id: string,
    rootId: string,
    relative: string,
    options?: WorkspaceOptions
  ) => Promise<FilePage>;
  'workspace:release': (cursor: string) => boolean;
  'skills:list': (id: string) => Promise<Skill[]>;
  'meeting:create': (id: string, title: string, source?: string) => Meeting;
  'meeting:get': (id: string) => Meeting;
  'meeting:delete': (id: string) => Promise<Removal>;
  'meeting:update': (
    id: string,
    patch: Partial<Meeting>,
    version?: number,
    scope?: NoteAnnotation[]
  ) => Meeting;
  'meeting:revisions': (id: string) => Revision[];
  'settings:save': (settings: Partial<Settings>) => Promise<Settings>;
  'agents:detect': (draft?: Partial<LlmSettings>) => Promise<DetectedAgent[]>;
  'connection:asr-start': (id: string, draft: Partial<Settings>) => Promise<SpeechConnection>;
  'connection:asr-audio': (id: string, bytes: ArrayBuffer) => boolean;
  'connection:asr-commit': (id: string) => void;
  'connection:rtc-signal': (id: string, offer: string) => Promise<RTCSessionDescriptionInit>;
  'connection:rtc-event': (id: string, data: unknown) => void;
  'connection:agent-test': (
    id: string,
    draft: Partial<Settings>
  ) => Promise<{ reply: string; backend: string }>;
  'connection:stop': (id: string, graceful?: boolean) => Promise<void>;
  'window:control': (action: string) => void;
  'clipboard:write': (text: string) => Promise<void>;
  'media:status': () => MediaPermissions;
  'media:prepare': (source: string) => Promise<MediaPermissions>;
  'media:settings': (kind: 'microphone' | 'screen') => Promise<void>;
  'media:playback-devices': () => Promise<PlaybackDevice[]>;
  'media:playback-start': (id: string, deviceId: string) => Promise<{ sampleRate: number }>;
  'media:playback-stop': (id: string) => void;
  'audio:start': (id: string) => Promise<string>;
  'audio:chunk': (id: string, bytes: ArrayBuffer) => number;
  'audio:finish': (id: string, duration: number, interrupted?: boolean) => Meeting;
  'audio:jobs': () => AudioJob[];
  'audio:cancel': (id: string) => Promise<void>;
  'asr:start': (id: string) => Promise<SpeechConnection>;
  'asr:audio': (id: string, bytes: ArrayBuffer) => boolean;
  'asr:commit': (id: string) => void;
  'asr:stop': (id: string) => Promise<void>;
  'asr:tasks': (filter?: TaskFilter) => TaskPage;
  'asr:task-ranges': (
    id: string,
    offset: number
  ) => { items: ChunkRange[]; nextOffset: number | null };
  'asr:task-action': (ids: string[], action: TaskAction) => Promise<void>;
  'asr:background': (paused: boolean) => Promise<void>;
  'asr:auto-recovery': (meetingId: string, enabled?: boolean) => boolean;
  'asr:reassign': (ids: string[]) => Promise<void>;
  'asr:connections': () => AsrConnectionStatus[];
  'asr:connection-action': (id: string, action: ConnectionAction) => void;
  'asr:online': () => void;
  'rtc:signal': (id: string, offer: string, epoch?: number) => Promise<RTCSessionDescriptionInit>;
  'rtc:event': (id: string, data: unknown, elapsed: number, epoch?: number) => void;
  'rtc:state': (id: string, epoch: number, connected: boolean, failure?: FailureInfo) => void;
  'rtc:config': (id: string, epoch: number) => SpeechConnection;
  'file:pick': (kind: string) => Promise<PickedFile[]>;
  'file:transcribe': (
    projectId: string,
    fileId: string,
    options?: AudioOptions
  ) => Promise<Meeting>;
  'recording:transcribe': (
    id: string,
    recordingId: string,
    options?: AudioOptions
  ) => Promise<Meeting>;
  'agent:run': (request: AgentRequest) => Promise<AgentRun>;
  'agent:submit': Agent['submit'];
  'agent:promote': (id: string, runId: string, sessionId?: string) => ReturnType<Agent['promote']>;
  'agent:temporary-begin': (meetingId: string) => { id: string; meetingId: string };
  'agent:temporary-end': (id: string) => Promise<void>;
  'agent:temporary-annotations': (
    id: string,
    meetingId: string,
    annotations: NoteAnnotation[],
    version: number
  ) => Meeting;
  'agent:temporary-apply': (
    id: string,
    meetingId: string,
    patch: Partial<Meeting>,
    version?: number,
    scope?: NoteAnnotation[]
  ) => Meeting;
  'agent:image-add': (
    meetingId: string,
    name: string,
    bytes: Uint8Array,
    sessionId?: string
  ) => ImageAttachment;
  'agent:image-release': (id: string) => void;
  'agent:input-state': (meetingId: string, sessionId?: string) => InputState;
  'agent:resume': (meetingId: string, sessionId?: string) => InputState;
  'agent:cancel': (id: string) => void;
  'agent:approve': (id: string, accepted: boolean) => void;
  'agent:command': (
    meetingId: string,
    command: string,
    sessionId?: string
  ) => ReturnType<Agent['submit']> | { cleared: boolean };
  'agent:trace': (
    meetingId: string,
    sessionId?: string
  ) => { runId: string; status: string; events: AgentEvent[] } | null;
  'export:docx': (id: string, transcript?: boolean) => Promise<string | null>;
}
export interface IpcEvents {
  'asr:event': AsrEvent;
  'agent:event': AgentEvent;
  'meeting:event': Meeting;
  'audio:progress': AudioJob;
  'app:close-request': Record<string, never>;
  'connection:event': ConnectionEvent;
  'media:playback': PlaybackEvent;
  'asr:tasks-changed': { meetingId?: string };
  'asr:connection': AsrConnectionStatus;
}
export type Invoke = <K extends keyof IpcCommands>(
  name: K,
  ...args: Parameters<IpcCommands[K]>
) => Promise<Awaited<ReturnType<IpcCommands[K]>>>;
export type Handle = <K extends keyof IpcCommands>(
  name: K,
  handler: (...args: Parameters<IpcCommands[K]>) => ReturnType<IpcCommands[K]>
) => void;
