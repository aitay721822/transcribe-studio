export type MentionToken = { start: number; end: number; query: string };

export function mentionToken(input: HTMLTextAreaElement): MentionToken | null {
  if (input.selectionStart !== input.selectionEnd) return null;
  const end = input.selectionStart;
  const match = /(?:^|[\s(])@([^@\r\n]{0,200})$/.exec(input.value.slice(0, end));
  return match ? { start: end - match[1].length - 1, end, query: match[1].trim() } : null;
}
