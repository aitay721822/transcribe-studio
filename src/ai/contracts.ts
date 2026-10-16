import type {
  AgentEvent,
  AgentRequest,
  ImageData,
  Meeting,
  Project,
  Settings,
  Skill,
} from '../domain/models';

export type BackendId = 'openai' | 'codex' | 'claude';
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ToolPort {
  specs(): ToolSpec[];
  call(name: string, args: unknown): Promise<unknown>;
}
export interface SessionBinding {
  id: string;
  fingerprint: string;
  home?: string;
}
export interface HarnessContext {
  request: AgentRequest;
  meeting: Meeting;
  project: Project;
  settings: Settings;
  skills: Skill[];
  prompt: string;
  instructions: string;
  runtimeDir: string;
  tools: ToolPort;
  controller: AbortController;
  signal: AbortSignal;
  maxSteps: number;
  ephemeral?: boolean;
  images?: ImageData[];
  result?: { schema: Record<string, unknown>; parse(text: string): string };
  emit(event: AgentEvent): void;
  bindSession(binding: SessionBinding): void;
  bindSteer?(handler: ((text: string, images?: ImageData[]) => Promise<boolean>) | null): void;
  bindTurn?(id: string): void;
}
/** The application depends only on this port, never on a vendor runtime. */
export interface HarnessAdapter {
  readonly id: BackendId;
  execute(context: HarnessContext): Promise<string>;
  close?(): Promise<void>;
}
