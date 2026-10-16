import type { AgentRequest, Meeting } from '../models';

export function activeMessages(request: AgentRequest, meeting: Meeting) {
  return meeting.chats
    .slice(meeting.contextMemory?.messageCount || 0)
    .filter(
      (chat) =>
        !chat.id ||
        chat.id === request.messageId ||
        !meeting.agentHistory?.some(
          (run) =>
            run.messageId === chat.id &&
            (run.status === 'queued' || (run.status === 'cancelled' && !run.started))
        )
    );
}
