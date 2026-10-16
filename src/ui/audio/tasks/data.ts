import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskFilter, TaskPage } from '../../../domain/asr/tasks';

export function useTaskList(filter: TaskFilter) {
  const { projectId, meetingId, source, state, offset, limit } = filter;
  const [page, setPage] = useState<TaskPage>();
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const alive = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const value = await window.studio.invoke('asr:tasks', {
        projectId,
        meetingId,
        source,
        state,
        offset,
        limit,
      });
      if (alive.current && sequence.current === request) {
        setPage(value);
        setError('');
      }
    } catch (error) {
      if (alive.current && sequence.current === request)
        setError(error instanceof Error ? error.message : '無法取得辨識任務');
    }
  }, [projectId, meetingId, source, state, offset, limit]);
  useEffect(() => {
    alive.current = true;
    setPage(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 100);
    };

    const unsubscribe = window.studio.on('asr:tasks-changed', changed);
    window.addEventListener('focus', changed);
    void refresh();
    return () => {
      alive.current = false;
      sequence.current++;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', changed);
    };
  }, [refresh]);
  return { page, error, refresh };
}

export function useTaskClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
