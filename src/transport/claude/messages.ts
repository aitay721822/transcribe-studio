export interface ClaudeMessage {
  type: string;
  uuid?: string;
  subtype?: string;
  status?: string;
  compact_result?: string;
  compact_error?: string;
  compact_metadata?: unknown;
  session_id?: string;
  is_error?: boolean;
  errors?: string[];
  result?: string;
  structured_output?: unknown;
}
export interface ClaudeContent {
  type: string;
  text?: string;
  source?: { type: string; media_type: string; data: string };
}
