import { z } from 'zod';
import type { AudioJob } from '../../domain/asr/file-progress';
import { type AsrTask, taskAction, taskSource, taskState } from '../../domain/asr/tasks';
import type { DesktopContext } from '../context';

const filterSchema = z
  .object({
    projectId: z.string().optional(),
    meetingId: z.string().optional(),
    source: taskSource.optional(),
    state: taskState.optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const idsSchema = z.array(z.string().min(1).max(100)).min(1).max(100);

export function legacyAudioJob(task: AsrTask): AudioJob {
  const stage = task.stage === 'capture' ? 'transcribe' : task.stage;
  let state: AudioJob['stage'] = stage;
  if (task.state === 'completed') state = 'completed';
  if (task.state === 'cancelled') state = 'cancelled';
  if (task.state === 'needs_attention') state = 'failed';
  return {
    id: task.id,
    meetingId: task.meetingId,
    projectId: task.projectId,
    title: task.title,
    stage: state,
    lastStage: stage,
    denoise: task.denoise,
    message: task.error?.message,
    chunk: task.completedChunks,
    totalChunks: task.totalChunks,
    seconds: task.completedSeconds,
    totalSeconds: Math.max(0, task.end - task.start),
    percent: task.totalChunks ? (task.completedChunks / task.totalChunks) * 100 : 0,
  };
}

export function registerAsrTasks(ctx: DesktopContext): void {
  const { asrTasks } = ctx;
  ctx.handle('audio:jobs', () => asrTasks.repository.list({ limit: 20 }).items.map(legacyAudioJob));
  ctx.handle('audio:cancel', (id) => asrTasks.act([z.string().parse(id)], 'cancel'));
  ctx.handle('asr:tasks', (filter) => {
    const page = asrTasks.repository.list(filterSchema.parse(filter || {}));
    return { ...page, items: page.items.map(({ inputFile: _inputFile, ...task }) => task) };
  });
  ctx.handle('asr:task-action', (ids, action) =>
    asrTasks.act(idsSchema.parse(ids), taskAction.parse(action))
  );
  ctx.handle('asr:task-ranges', (id, offset) => {
    const task = asrTasks.repository.task(z.string().parse(id));
    const start = z.number().int().min(0).parse(offset);
    if (!task || task.deleted) throw new Error('找不到辨識任務');
    const items = asrTasks.repository
      .chunks(id, start, 20)
      .map(({ id, start, end, state, attempts, failures }) => ({
        id,
        start,
        end,
        state,
        attempts,
        failures,
      }));
    return {
      items,
      nextOffset: start + items.length < task.totalChunks ? start + items.length : null,
    };
  });
  ctx.handle('asr:background', (paused) => asrTasks.pauseBackground(z.boolean().parse(paused)));
  ctx.handle('asr:auto-recovery', (id, enabled) => {
    ctx.meeting(id);
    if (enabled !== undefined) z.boolean().parse(enabled);
    const value = asrTasks.repository.autoRecovery(id, enabled);
    ctx.send('asr:tasks-changed', { meetingId: id });
    return value;
  });
  ctx.handle('asr:reassign', (ids) => asrTasks.reassign(idsSchema.parse(ids)));
}
