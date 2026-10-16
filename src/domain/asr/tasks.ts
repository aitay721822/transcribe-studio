import { z } from 'zod';

export const taskState = z.enum([
  'queued',
  'running',
  'waiting_retry',
  'paused',
  'needs_attention',
  'completed',
  'cancelled',
]);
export const taskSource = z.enum(['live', 'recovery', 'recording', 'import']);
export const taskAction = z.enum(['pause', 'resume', 'retry', 'cancel', 'delete']);
export const taskFailure = z.object({
  kind: z.enum([
    'connection',
    'timeout',
    'rate_limit',
    'server',
    'configuration',
    'audio',
    'unknown',
  ]),
  message: z.string(),
  scope: z.enum(['service', 'chunk', 'none']),
  status: z.number().optional(),
  retryAt: z.number().optional(),
});
export const taskSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  projectId: z.string(),
  recordingId: z.string(),
  title: z.string(),
  source: taskSource,
  state: taskState,
  serviceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextAttemptAt: z.number(),
  attempts: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  deleted: z.boolean(),
  sealed: z.boolean(),
  deferred: z.boolean().default(false),
  reviewRequired: z.boolean().default(false),
  unpersistedRanges: z
    .array(z.object({ start: z.number(), end: z.number(), message: z.string() }))
    .default([]),
  stage: z.enum(['capture', 'decode', 'denoise', 'segment', 'transcribe']),
  denoise: z.boolean(),
  start: z.number(),
  end: z.number(),
  totalChunks: z.number().int().nonnegative(),
  completedChunks: z.number().int().nonnegative(),
  completedSeconds: z.number().nonnegative(),
  inputFile: z.string().optional(),
  recordingOffset: z.number().default(0),
  rangeStart: z.number().nonnegative().default(0),
  rangeEnd: z.number().nonnegative().optional(),
  replace: z.boolean(),
  error: taskFailure.optional(),
});
export type AsrTask = z.infer<typeof taskSchema>;
export type TaskState = z.infer<typeof taskState>;
export type TaskSource = z.infer<typeof taskSource>;
export type TaskAction = z.infer<typeof taskAction>;

export const chunkSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  index: z.number().int().nonnegative(),
  start: z.number(),
  end: z.number(),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  checksum: z.string(),
  state: z.enum(['queued', 'running', 'completed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  lease: z.string(),
  result: z.string().optional(),
  overlap: z.boolean().default(false),
});
export type AsrChunk = z.infer<typeof chunkSchema>;

export interface TaskFilter {
  projectId?: string;
  meetingId?: string;
  source?: TaskSource;
  state?: TaskState;
  offset?: number;
  limit?: number;
}

export interface TaskPage {
  items: AsrTask[];
  total: number;
  active: number;
  offset: number;
  nextOffset: number | null;
  backgroundPaused: boolean;
}

export type ChunkRange = Pick<AsrChunk, 'id' | 'start' | 'end' | 'state' | 'attempts' | 'failures'>;

export interface ServiceHealth {
  id: string;
  failures: number;
  nextAttemptAt: number;
  notBefore: number;
  error?: z.infer<typeof taskFailure>;
}

export function isTaskActive(task: AsrTask): boolean {
  return !task.deleted && ['queued', 'running', 'waiting_retry'].includes(task.state);
}
