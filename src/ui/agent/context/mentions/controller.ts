import { useEffect, useRef, useState } from 'react';
import type { Invoke } from '../../../../domain/ipc';
import type { ContextReference, Meeting, UiState } from '../../../../domain/models';
import type { FileList } from '../../../../domain/workspace';
import { invalidateUI } from '../../../layout/roots';
import { referenceDrafts, referenceKey } from './chips';
import { type MentionToken, mentionToken } from './token';

const api: Invoke = (name, ...args) => window.studio.invoke(name, ...args);

export function useMentions(state: UiState, meeting: Meeting) {
  const [token, setToken] = useState<MentionToken | null>(null);
  const [page, setPage] = useState<FileList>(null),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState(''),
    [selected, setSelected] = useState(0);
  const current = useRef({ generation: 0, job: '', cursor: null as string | null });
  const dismissed = useRef('');

  const signature = (input: HTMLTextAreaElement) =>
    JSON.stringify([input.value, input.selectionStart, input.selectionEnd]);

  const project = state.projects.find((p) => p.id === meeting.projectId);

  function release() {
    const c = current.current;
    if (c.job) void api('workspace:mention-cancel', c.job).catch(() => {});
    if (c.cursor) void api('workspace:mention-release', c.cursor).catch(() => {});
    c.job = '';
    c.cursor = null;
  }

  useEffect(() => {
    const generation = ++current.current.generation;
    release();
    setPage(null);
    setError('');
    setSelected(0);
    setLoading(!!token);
    if (!token) return;
    const timer = setTimeout(() => void load(generation, token.query), 220);
    return () => {
      clearTimeout(timer);
      current.current.generation++;
      release();
    };
  }, [token?.query, !!token, meeting.projectId]);

  async function load(generation: number, query: string, cursor?: string) {
    const id = crypto.randomUUID();
    current.current.job = id;
    current.current.cursor = null;
    setLoading(true);
    setError('');
    try {
      const result = await api('workspace:mentions', meeting.projectId, query, id, cursor);
      if (generation !== current.current.generation) {
        if (result.nextCursor) void api('workspace:mention-release', result.nextCursor);
        return;
      }
      current.current.cursor = result.nextCursor;
      setPage(result);
      setSelected(0);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (generation === current.current.generation) setError(e.message);
    } finally {
      if (generation === current.current.generation) {
        current.current.job = '';
        setLoading(false);
      }
    }
  }

  function close() {
    const input = document.getElementById('agent-input') as HTMLTextAreaElement;
    if (input) dismissed.current = signature(input);
    current.current.generation++;
    release();
    setToken(null);
  }

  function update(input: HTMLTextAreaElement, force = false) {
    if (!force && dismissed.current === signature(input)) return;
    dismissed.current = '';
    setToken(mentionToken(input));
  }

  function finishToken() {
    const input = document.getElementById('agent-input') as HTMLTextAreaElement;
    if (token && input) {
      input.setRangeText('', token.start, token.end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
    close();
  }

  function attach(reference: ContextReference) {
    const refs = referenceDrafts(state, meeting);
    if (!refs.some((r) => referenceKey(r) === referenceKey(reference))) {
      if (refs.length >= 20) {
        setError('每則訊息最多指定 20 個參考項目');
        return;
      }
      state.referenceDrafts[meeting.id] = [...refs, reference];
    }
    finishToken();
    invalidateUI();
  }

  async function choose(reference: ContextReference) {
    if (reference.kind === 'search') {
      attach(reference);
      return;
    }
    const generation = current.current.generation;
    try {
      const resolved = await api(
        'workspace:resolve-reference',
        meeting.projectId,
        reference.rootId,
        reference.relative
      );
      if (generation === current.current.generation) attach(resolved);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (generation === current.current.generation) setError(e.message);
    }
  }

  const options: ContextReference[] = [
    ...(page?.files || []).map((file) => ({ ...file, kind: file.kind || ('file' as const) })),
    ...(token?.query ? [{ kind: 'search' as const, query: token.query }] : []),
  ];

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!token) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && options[selected])
        void choose(options[selected]);
      return true;
    }
    if (['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (options.length) {
        if (event.key === 'Tab') void choose(options[selected]);
        else
          setSelected(
            (selected + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
          );
      }
      return true;
    }
    return false;
  }

  return {
    token,
    page,
    loading,
    error,
    selected,
    options,
    project,
    skills: state.skills,

    chooseSkill: (id: string) => {
      const select = document.getElementById('skill-select') as HTMLSelectElement;
      if (select) {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      finishToken();
    },

    update,
    close,
    choose,
    onKeyDown,

    more: () => {
      if (!loading && token && current.current.cursor)
        void load(current.current.generation, token.query, current.current.cursor);
    },

    resolve: async (rootId: string, relative: string) => {
      const generation = current.current.generation;
      try {
        const r = await api('workspace:resolve-reference', meeting.projectId, rootId, relative);
        if (generation === current.current.generation) attach(r);
      } catch (caughtE) {
        const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

        if (generation === current.current.generation) setError(e.message);
      }
    },
  };
}
