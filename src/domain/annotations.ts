export interface NoteAnnotation {
  id: string;
  start: number;
  end: number;
  quote: string;
  comment: string;
  status: 'pending' | 'stale' | 'resolved';
  createdAt: string;
}

export function validateAnnotations(value: unknown, notes: string): NoteAnnotation[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('最多可建立 50 則標記');
  const ids = new Set<string>();
  return value.map((a) => {
    if (
      !a ||
      typeof a.id !== 'string' ||
      !a.id ||
      a.id.length > 100 ||
      ids.has(a.id) ||
      !Number.isInteger(a.start) ||
      !Number.isInteger(a.end) ||
      a.start < 0 ||
      a.end <= a.start ||
      typeof a.quote !== 'string' ||
      !a.quote.trim() ||
      a.quote.length > 80000 ||
      typeof a.comment !== 'string' ||
      !a.comment.trim() ||
      a.comment.length > 4000 ||
      !['pending', 'stale', 'resolved'].includes(a.status) ||
      typeof a.createdAt !== 'string'
    )
      throw new Error('標記資料無效');
    if (a.status === 'pending' && notes.slice(a.start, a.end) !== a.quote)
      throw new Error('標記原文已變動，請重新選取');
    ids.add(a.id);
    return {
      id: a.id,
      start: a.start,
      end: a.end,
      quote: a.quote,
      comment: a.comment.trim(),
      status: a.status,
      createdAt: a.createdAt,
    };
  });
}

/** Preserve exact ranges for edits outside a mark; never guess among duplicate quotes. */
export function rebaseAnnotations(
  marks: NoteAnnotation[],
  before: string,
  after: string
): NoteAnnotation[] {
  if (before === after) return marks;
  let start = 0,
    end = before.length,
    nextEnd = after.length;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const delta = after.length - before.length;
  return marks.map((a) => {
    if (a.status !== 'pending') return a;
    if (a.end <= start) return a;
    if (a.start >= end) return { ...a, start: a.start + delta, end: a.end + delta };
    return { ...a, status: 'stale' };
  });
}

export function annotationTargets(
  notes: string,
  marks: NoteAnnotation[],
  ids: string[]
): NoteAnnotation[] {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 50 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string')
  )
    throw new Error('標記選擇無效');
  const selected = ids
    .map((id) => {
      const mark = marks.find((a) => a.id === id);
      if (!mark || mark.status !== 'pending' || notes.slice(mark.start, mark.end) !== mark.quote)
        throw new Error('標記原文已變動或已移除，請重新標記後再修訂');
      return mark;
    })
    .sort((a, b) => a.start - b.start);
  if (selected.some((a, i) => i > 0 && a.start < selected[i - 1].end))
    throw new Error('標記範圍重疊，請合併或移除重疊標記');
  return selected;
}

export function assertAnnotationScope(
  notes: string,
  marks: NoteAnnotation[],
  scope: NoteAnnotation[]
) {
  if (!Array.isArray(scope)) throw new Error('標記快照無效');
  const current = annotationTargets(
    notes,
    marks,
    scope.map((a) => a?.id)
  );
  if (
    scope.some(
      (a) =>
        !current.some(
          (b) =>
            b.id === a.id &&
            b.start === a.start &&
            b.end === a.end &&
            b.quote === a.quote &&
            b.comment === a.comment
        )
    )
  )
    throw new Error('標記已有新的修改指示，請重新執行 Agent');
}
