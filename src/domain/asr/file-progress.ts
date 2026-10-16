export const AUDIO_STAGES = [
  { id: 'decode', label: '解碼與轉檔' },
  { id: 'denoise', label: '降低背景雜音' },
  { id: 'segment', label: '停頓偵測與分段' },
  { id: 'transcribe', label: '語音辨識' },
] as const;
export interface FileProgress {
  stage: (typeof AUDIO_STAGES)[number]['id'] | 'completed' | 'failed' | 'cancelled';
  percent?: number;
  seconds?: number;
  totalSeconds?: number;
  chunk?: number;
  totalChunks?: number;
  denoise?: boolean;
  message?: string;
}
export interface AudioJob extends FileProgress {
  id: string;
  meetingId: string;
  projectId: string;
  title: string;
  lastStage?: (typeof AUDIO_STAGES)[number]['id'];
}

export const audioJobActive = (job: FileProgress) =>
  !['completed', 'failed', 'cancelled'].includes(job.stage);
