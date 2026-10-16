import type { UiState } from '../../domain/models';
import { audioViews } from '../application/pages/audio';
import { chromeViews } from '../application/pages/chrome';
import { pageContext } from '../application/pages/contracts';
import { libraryViews } from '../application/pages/library';
import { agentViews } from '../application/pages/meeting/agent';
import { sourceViews } from '../application/pages/meeting/source';
import { workspaceViews } from '../application/pages/meeting/workspace';
import { settingsViews } from '../application/pages/settings';
import type { AudioCapture } from '../audio/capture';

export function createViews(state: UiState, capture: AudioCapture) {
  const context = pageContext(state, capture),
    library = libraryViews(context);
  return {
    ...chromeViews(context),
    ...library,
    ...audioViews(context, library.meetingsTable),
    ...sourceViews(context),
    ...workspaceViews(context),
    ...agentViews(context),
    ...settingsViews(context),
  };
}
