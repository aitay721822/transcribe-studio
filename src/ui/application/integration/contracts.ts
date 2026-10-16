import type { AgentController } from '../../agent/controller';
import type { AudioController } from '../../audio/controller';
import type { AnnotationController } from '../annotations/controller';
import type { ProjectController } from '../projects';
import type { SettingsController } from '../settings';
import type { WorkspaceController } from '../workspace';

export interface Controllers {
  workspace: WorkspaceController;
  projects: ProjectController;
  audio: AudioController;
  agent: AgentController;
  annotations: AnnotationController;
  diagnostics: ReturnType<typeof import('../diagnostics/controller').createDiagnosticController>;
  settings: SettingsController;
  actions: Record<string, () => unknown>;
}
export type ControllerSet = Omit<Controllers, 'actions'>;
