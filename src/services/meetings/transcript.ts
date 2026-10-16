import { randomUUID } from 'node:crypto';

function time(value: string) {
  const parts = value.replace(',', '.').split(':').map(Number);
  return parts.reduce((a, n) => a * 60 + n, 0);
}

function parseTranscript(text: string) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => /\d{1,2}:\d{2}(?::\d{2})?[.,]\d+\s*-->/.test(l));
    if (ti < 0) continue;
    const [start, end] = lines[ti].split('-->').map((s) => s.trim().split(/\s/)[0]);
    segments.push({
      id: randomUUID(),
      start: time(start),
      end: time(end),
      text: lines.slice(ti + 1).join('\n'),
      final: true,
      speaker: '',
      timing: 'provider',
    });
  }
  return segments.length
    ? segments
    : [{ id: randomUUID(), start: 0, end: 0, text, final: true, speaker: '', timing: 'unknown' }];
}

export { parseTranscript };
