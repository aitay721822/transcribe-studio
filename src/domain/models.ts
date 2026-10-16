import type { NoteAnnotation } from './annotations';
import type { AsrSettings } from './asr/config';
import type { AudioJob } from './asr/file-progress';
import type { InputDevice } from './audio-devices';

export interface WorkspaceRoot {
  id: string;
  path: string;
  name: string;
  mode: 'readonly';
}
export interface Project {
  id: string;
  name: string;
  roots: WorkspaceRoot[];
  createdAt: string;
  archivedAt?: string | null;
  pinned?: boolean;
  section?: string;
}
export interface TranscriptSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  final: boolean;
  speaker?: string;
  timing?: string;
  recordingId?: string;
  providerId?: string;
}
export interface Reference {
  rootId: string;
  rootName: string;
  relative: string;
}
export type ContextReference =
  | (Reference & { kind: 'file' | 'directory' })
  | { kind: 'search'; query: string };
export interface ChatMessage {
  id?: string;
  text: string;
  createdAt: string;
  references?: ContextReference[];
  images?: ImageAttachment[];
  mode?: 'edit' | 'read';
}
export interface ImageAttachment {
  id: string;
  name: string;
  mime: 'image/png';
  width: number;
  height: number;
}
export interface ImageData extends ImageAttachment {
  dataUrl: string;
}
export interface Recording {
  id: string;
  url?: string;
  path?: string;
  offset?: number;
  duration?: number;
  complete: boolean;
  bytes?: number;
  startedAt: string;
}
export interface Meeting {
  id: string;
  projectId: string;
  title: string;
  source: string;
  status: string;
  notes: string;
  annotations?: NoteAnnotation[];
  version: number;
  createdAt: string;
  updatedAt: string;
  duration: number;
  segments: TranscriptSegment[];
  recordings: Recording[];
  markers: { time: number; label: string }[];
  chats: ChatMessage[];
  references: Reference[];
  agentSessions?: Record<string, { id: string; fingerprint: string; home?: string }>;
  contextMemory?: { summary: string; messageCount: number; throughId?: string };
  agentHistory?: {
    runId: string;
    status: string;
    notes?: string;
    answer?: string;
    messageId?: string;
    started?: boolean;
    createdAt: string;
    version?: number;
  }[];
}
export interface LlmSettings {
  backend?: 'openai' | 'codex' | 'claude' | 'responses';
  baseUrl: string;
  model: string;
  apiKey: string;
  maxSteps: number;
  maxToolCalls?: number;
  timeoutMinutes?: number;
  autoCompact?: boolean;
  compactThreshold?: number;
  codexPath?: string;
  codexAuth?: 'cli' | 'api';
  codexModel?: string;
  claudeAuth?: 'cli' | 'api';
  claudeKey?: string;
  claudeModel?: string;
  claudePath?: string;
}
export interface McpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled: boolean;
}
export interface Settings {
  theme: string;
  llm: LlmSettings;
  asr: AsrSettings;
  mcp: McpServer[];
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  content?: string;
}
export interface AgentRequest {
  messageId?: string;
  command?: 'compact';
  meetingId: string;
  instruction: string;
  selection?: string;
  annotationIds?: string[];
  skillIds?: string[];
  references?: ContextReference[];
  mode?: 'edit' | 'read';
  sessionId?: string;
  images?: ImageAttachment[];
}
export interface AgentEvent {
  type: string;
  runId?: string;
  meetingId?: string;
  id?: string;
  accepted?: boolean;
  message?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  notes?: string;
  version?: number;
  itemId?: string;
  delta?: string;
  callId?: string;
  timestamp?: string;
  durationMs?: number;
  status?: 'running' | 'completed' | 'error' | 'cancelled';
  annotationIds?: string[];
  annotationScope?: NoteAnnotation[];
  sessionId?: string;
}
export interface AgentRun {
  id: string;
  meetingId: string;
  version: number;
  status: 'queued' | 'steered' | 'running' | 'proposed' | 'failed' | 'cancelled';
  input?: AgentRequest;
  events: AgentEvent[];
  startedAt: string;
  backend?: string;
  notes?: string;
  threadId?: string;
  turnId?: string;
}
export interface AgentEntities {
  meetings: Meeting;
  projects: Project;
}
export interface AgentStore {
  conversations?: import('../persistence/conversations').ConversationRepository;
  meetings(): Meeting[];
  get<T extends keyof AgentEntities>(table: T, id: string): AgentEntities[T];
  settings(): Settings;
  saveRun(run: AgentRun): void;
  queuedRuns?(): AgentRun[];
  updateMeeting?(id: string, patch: Partial<Meeting>): Meeting;
}
export interface UiState {
  projects: Project[];
  meetings: Meeting[];
  settings: Settings;
  view: string;
  projectId: string;
  meetingId: string;
  source: string;
  recordOnly: boolean;
  microphoneId?: string;
  inputDevices?: InputDevice[];
  audioSourceMode?: 'device' | 'file';
  sourceTab: string;
  editorTab: string;
  settingsTab: string;
  selectedFiles: { id: string; name: string; size: number }[];
  audioJobs?: AudioJob[];
  audioDenoise?: boolean;
  skills: Skill[];
  filter: string;
  statusFilter: string;
  proposal: {
    notes: string;
    version: number;
    annotationIds?: string[];
    annotationScope?: NoteAnnotation[];
  };
  runId: string;
  agentEvents: AgentEvent[];
  agentQueue?: {
    id: string;
    instruction: string;
    steering?: boolean;
    images?: ImageAttachment[];
    mode?: 'edit' | 'read';
    messageId?: string;
  }[];
  queuePaused?: boolean;
  discardedChatIds?: string[];
  dirty: boolean;
  selectionLength?: number;
  noteSelection?: { meetingId: string; start: number; end: number; quote: string };
  annotationDrafts?: Record<string, NoteAnnotation[]>;
  referenceDrafts?: Record<string, ContextReference[]>;
  agentMode?: 'edit' | 'read';
  temporaryChat?: { id: string; meetingId: string; chats: ChatMessage[] };
  imageDrafts?: Record<string, ImageAttachment[]>;
  saveTimer: ReturnType<typeof setTimeout>;
  saving?: Promise<void>;
  sidebarCollapsed: boolean;
  setupLocked?: boolean;
}
export interface StudioBridge {
  invoke: import('./ipc').Invoke;
  on<K extends keyof import('./ipc').IpcEvents>(
    name: K,
    callback: (value: import('./ipc').IpcEvents[K]) => void
  ): () => void;
}
declare global {
  interface Window {
    studio: StudioBridge;
  }
}
