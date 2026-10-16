import { createHash } from 'node:crypto';
import type { TranscriptionConfig } from '../../domain/transcription';
import { transcriptionEndpoint } from '../../domain/transcription';

/** Credentials stay in the encrypted settings vault and can rotate without rerouting jobs. */
export function transcriptionServiceId(config: TranscriptionConfig): string {
  let endpoint = config.fileUrl || '';
  try {
    endpoint = transcriptionEndpoint(config).href;
  } catch {
    /* Unconfigured fallback jobs must still be retained. */
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        endpoint,
        model: config.fileModel || '',
        language: config.language || '',
      })
    )
    .digest('hex');
}
