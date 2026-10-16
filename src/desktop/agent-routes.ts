import path from 'node:path';
import { assertAnnotationScope, validateAnnotations } from '../domain/annotations';
import type { IpcCommands } from '../domain/ipc';
import { TemporaryAgents } from '../services/agents/conversation/temporary';
import type { DesktopContext } from './context';

export function registerAgent(ctx: DesktopContext) {
  const { handle, agent } = ctx;
  const temporary = new TemporaryAgents(
    {
      get: ctx.store.get.bind(ctx.store),

      meetings: () => ctx.store.meetings(),

      settings: ctx.settingsInternal,
    },
    ctx.bundledSkills,
    path.join(ctx.dataDir, 'runtime', 'temporary'),
    (event) => ctx.send('agent:event', event),
    ctx.images
  );

  const target = (id?: string, meetingId?: string) =>
    id ? temporary.get(id, meetingId).agent : agent;

  const journal = (id?: string, meetingId?: string) =>
    id ? temporary.get(id, meetingId).store.conversations : ctx.store.conversations;

  const busy = agent.isRunningMeeting.bind(agent);
  agent.isRunningMeeting = (id) =>
    busy(id) || temporary.values().some((s) => s.agent.isRunningMeeting(id));
  handle('agent:temporary-begin', (meetingId) => {
    if (agent.isRunningMeeting(meetingId)) throw new Error('請先停止工作並清空佇列');
    return temporary.begin(meetingId);
  });
  handle('agent:temporary-end', (id) => temporary.end(id));
  handle('agent:temporary-annotations', (id, meetingId, annotations, version) => {
    const selected = temporary.get(id, meetingId),
      meeting = ctx.meeting(meetingId);
    if (meeting.version !== version) throw new Error('文件已有新版本');
    return ctx.sanitizeMeeting(
      selected.store.updateMeeting(meetingId, {
        annotations: validateAnnotations(annotations, meeting.notes),
      })
    );
  });
  handle('agent:temporary-apply', (id, meetingId, patch, version, scope) => {
    const selected = temporary.get(id, meetingId),
      meeting = selected.store.get('meetings', meetingId);
    if (scope) assertAnnotationScope(meeting.notes, meeting.annotations || [], scope);
    if (typeof patch.notes !== 'string' || patch.notes.length > 1000000)
      throw new Error('文件內容無效或過大');
    return ctx.sanitizeMeeting(ctx.store.updateMeeting(meetingId, { notes: patch.notes }, version));
  });
  handle('agent:image-add', (meetingId, name, bytes, sessionId) => {
    ctx.meeting(meetingId);
    if (sessionId) temporary.get(sessionId, meetingId);
    return ctx.images.add(meetingId, name, bytes, sessionId);
  });
  handle('agent:image-release', (id) => ctx.images.release(id));

  const submit: IpcCommands['agent:submit'] = async (args, mode, expectedRunId) => {
    const selected = target(args.sessionId, args.meetingId);
    await ctx.images.prepare(args);
    if (args.sessionId) {
      const repository = journal(args.sessionId, args.meetingId);
      repository.syncMessages(args.meetingId, [
        ...repository.messages(args.meetingId),
        {
          id: args.messageId,
          text: args.instruction,
          createdAt: new Date().toISOString(),
          references: args.references,
          images: args.images,
          mode: args.mode,
        },
      ]);
    }
    return selected.submit(args, mode, expectedRunId);
  };

  handle('agent:run', async (args) => {
    await ctx.images.prepare(args);
    return target(args.sessionId, args.meetingId).run(args);
  });
  handle('agent:submit', submit);
  handle('agent:promote', (id, expectedRunId, sessionId) =>
    target(sessionId).promote(id, expectedRunId)
  );
  handle('agent:input-state', (meetingId, sessionId) =>
    target(sessionId, meetingId).inputState(meetingId)
  );
  handle('agent:resume', (meetingId, sessionId) => target(sessionId, meetingId).resume(meetingId));
  handle('agent:cancel', (id) => {
    agent.cancel(id);
    for (const session of temporary.values()) session.agent.cancel(id);
  });
  handle('agent:approve', (id, yes) => {
    agent.approve(id, yes);
    for (const session of temporary.values()) session.agent.approve(id, yes);
  });
  handle('agent:command', (meetingId, command, sessionId) => {
    ctx.meeting(meetingId);
    const selected = target(sessionId, meetingId);
    if (selected.isRunningMeeting(meetingId))
      throw new Error('請先停止目前工作並移除排隊訊息，再執行此指令');
    if (command === 'compact') {
      selected.resume(meetingId);
      return selected.submit({
        meetingId,
        instruction: '壓縮對話上下文',
        command: 'compact',
        sessionId,
      });
    }
    if (command === 'clear') {
      if (sessionId) ctx.images.clearSession(sessionId);
      journal(sessionId, meetingId).append(meetingId, 'conversation-reset', {
        reason: '使用者執行 /clear',
      });
      selected.resume(meetingId);
      return { cleared: true };
    }
    throw new Error('未知的指令，請使用 /compact、/clear 或 /help');
  });
  handle('agent:trace', (meetingId, sessionId) => {
    ctx.meeting(meetingId);
    const run = journal(sessionId, meetingId)
      .runs(meetingId)
      .filter((run) => run.events.some((event) => event.type === 'started'))
      .at(-1);
    return run ? { runId: run.id, status: run.status, events: run.events } : null;
  });
  return temporary;
}
