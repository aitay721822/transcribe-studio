import { rebaseAnnotations } from '../../../domain/annotations';
import type { UiState } from '../../../domain/models';
import { invalidateUI } from '../../layout/roots';

export async function toggleTemporary(state: UiState, enabled: boolean) {
  if (state.runId || state.agentQueue?.length)
    throw new Error('請先停止目前工作並清空佇列，再切換暫時對話');
  const id = state.meetingId;
  const api = window.studio.invoke;
  for (const image of state.imageDrafts?.[id] || []) await api('agent:image-release', image.id);
  if (state.imageDrafts) state.imageDrafts[id] = [];
  if (state.referenceDrafts) state.referenceDrafts[id] = [];
  if (state.annotationDrafts) state.annotationDrafts[id] = [];
  if (enabled) {
    const result = await api('agent:temporary-begin', id);
    state.temporaryChat = { ...result, chats: [] };
    state.agentEvents = [];
    state.proposal = null;
  } else if (state.temporaryChat) {
    const session = state.temporaryChat;
    state.temporaryChat = undefined;
    await api('agent:temporary-end', session.id);
    const meeting = await api('meeting:get', id);
    const index = state.meetings.findIndex((m) => m.id === id);
    if (index >= 0) {
      const notes = state.dirty ? state.meetings[index].notes : meeting.notes;
      state.meetings[index] = {
        ...meeting,
        notes,
        annotations: rebaseAnnotations(meeting.annotations || [], meeting.notes, notes),
      };
    }
    state.agentEvents = (await api('agent:trace', id))?.events || [];
    state.proposal = null;
  }
  invalidateUI();
}

export function discardTemporary(state: UiState, id?: string) {
  const session = state.temporaryChat;
  if (!session || (id && session.id !== id)) return;
  state.temporaryChat = undefined;
  state.discardedChatIds = [];
  state.agentEvents = [];
  state.agentQueue = [];
  state.runId = null;
  state.proposal = null;
  if (state.imageDrafts) state.imageDrafts[session.meetingId] = [];
  if (state.referenceDrafts) state.referenceDrafts[session.meetingId] = [];
  if (state.annotationDrafts) state.annotationDrafts[session.meetingId] = [];
  void window.studio.invoke('agent:temporary-end', session.id).catch(() => {});
}
