import { randomUUID } from 'node:crypto';
import type { TranscriptSegment } from '../../domain/models';
import { record } from '../../domain/value';

export function vllmTranscript(
  value: unknown,
  elapsed: number,
  cache: Map<string, TranscriptSegment>
) {
  const data = record(value);
  if (!['transcription.delta', 'transcription.done'].includes(String(data.type))) return null;
  const previous = cache.get('vllm-active');
  const final = data.type === 'transcription.done';

  const transcriptText = () => {
    if (final) {
      if (typeof data.text === 'string') {
        return data.text;
      }
      return previous?.text || '';
    }
    return `${previous?.text || ''}${typeof data.delta === 'string' ? data.delta : ''}`;
  };

  const segment = {
    id: previous?.id || randomUUID(),
    text: transcriptText(),
    start: previous?.start ?? elapsed,
    end: elapsed,
    final,
    speaker: '',
    timing: 'received',
  };
  if (final) cache.delete('vllm-active');
  else cache.set('vllm-active', segment);
  return segment;
}
