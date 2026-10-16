import type { UiState } from '../../../domain/models';
import type { AudioCapture } from '../../audio/capture';

export interface PageContext {
  state: UiState;
  capture: AudioCapture;
  project: () => UiState['projects'][number];
  current: () => UiState['meetings'][number];
}

export function pageContext(state: UiState, capture: AudioCapture): PageContext {
  return {
    state,
    capture,

    project: () => state.projects.find((p) => p.id === state.projectId),

    current: () => state.meetings.find((m) => m.id === state.meetingId),
  };
}
