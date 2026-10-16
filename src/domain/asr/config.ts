import type { TranscriptSegment } from '../models';

export interface AsrSettings {
  provider: string;
  realtimeFlavor?: string;
  url: string;
  model: string;
  fileModel?: string;
  fileUrl?: string;
  fileHeaders?: Record<string, string>;
  fileApiKey?: string;
  chunkSeconds?: number;
  apiKey: string;
  language: string;
  sampleRate: number;
  headers: Record<string, string>;
  init: Record<string, unknown>;
  audioMode: string;
  audioField: string;
  audioEnvelope: Record<string, unknown>;
  mapping: Record<'text' | 'id' | 'final' | 'speaker' | 'start' | 'end', string>;
  signalingUrl: string;
  signalingMode: string;
  channel: string;
  iceServers: RTCIceServer[];
}
export interface AsrEvent {
  type: string;
  segment?: TranscriptSegment;
  message?: string;
  meetingId?: string;
  level?: number;
  asr?: boolean;
  paused?: boolean;
}
export interface SpeechSession {
  connect(): Promise<void>;
  audio(buffer: ArrayBuffer): boolean;
  commit(): void;
  close(): Promise<void>;
  cancel?(): void;
  ws?: import('ws').default;
}
