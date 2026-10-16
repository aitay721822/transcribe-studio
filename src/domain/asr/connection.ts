import type { FailureInfo } from './retry';

export interface AsrConnectionStatus {
  meetingId: string;
  recordingId: string;
  state: 'connecting' | 'connected' | 'waiting_retry' | 'needs_attention' | 'paused' | 'closed';
  attempts: number;
  nextAttemptAt: number;
  epoch: number;
  error?: FailureInfo;
}
export type ConnectionAction = 'retry' | 'pause' | 'resume' | 'reconfigure';
