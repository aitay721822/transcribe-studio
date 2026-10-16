import { annotationTargets } from '../../domain/annotations';
import type { AgentRequest, Meeting } from '../../domain/models';

export function annotationRevision(request: AgentRequest, meeting: Meeting) {
  if (request.annotationIds === undefined) return undefined;
  const targets = annotationTargets(
    meeting.notes,
    meeting.annotations || [],
    request.annotationIds
  );
  return {
    targets,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['replacements'],
      properties: {
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'text'],
            properties: { id: { type: 'string' }, text: { type: 'string' } },
          },
        },
      },
    },

    parse(text: string): string {
      const data = JSON.parse(
        text
          .trim()
          .replace(/^```(?:json)?\s*\n?/, '')
          .replace(/\n?```$/, '')
      );
      if (!Array.isArray(data.replacements) || data.replacements.length !== targets.length)
        throw new Error('Agent 必須為每則標記提供一個替換內容');
      const replacements = new Map<string, string>();
      for (const item of data.replacements) {
        if (
          !item ||
          !targets.some((a) => a.id === item.id) ||
          replacements.has(item.id) ||
          typeof item.text !== 'string' ||
          item.text.length > 80000
        )
          throw new Error('Agent 回傳無效或重複的標記替換內容');
        replacements.set(item.id, item.text);
      }
      let notes = meeting.notes;
      for (const a of [...targets].reverse())
        notes = `${notes.slice(0, a.start)}${replacements.get(a.id)}${notes.slice(a.end)}`;
      return notes;
    },
  };
}
