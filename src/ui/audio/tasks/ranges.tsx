import { useEffect, useState } from 'react';
import type { AsrTask, ChunkRange } from '../../../domain/asr/tasks';
import { duration } from '../../components/display';
import { Button } from '../../primitives/button';
import { Disclosure, DisclosureTrigger } from '../../primitives/disclosure';

const labels: Record<ChunkRange['state'], string> = {
  queued: '尚未辨識',
  running: '辨識中',
  completed: '已完成',
  cancelled: '已取消、尚未辨識',
};

export function TaskRanges({ task }: { task: AsrTask }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<ChunkRange[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void window.studio
      .invoke('asr:task-ranges', task.id, offset)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setNext(page.nextOffset);
        setError('');
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : '無法讀取範圍');
      });
    return () => {
      alive = false;
    };
  }, [open, offset, task.id, task.updatedAt, task.completedChunks]);
  if (!task.totalChunks) return null;
  return (
    <Disclosure onToggle={(event) => setOpen(event.currentTarget.open)}>
      <DisclosureTrigger>檢視已完成與未辨識範圍</DisclosureTrigger>
      {open && (
        <>
          {error && <p role="alert">{error}</p>}
          {items.map((chunk) => (
            <p key={chunk.id}>
              {duration(chunk.start)}–{duration(chunk.end)} · {labels[chunk.state]} · 嘗試{' '}
              {chunk.attempts} 次
            </p>
          ))}
          <div className="asr-task-pagination">
            <Button
              className="btn small"
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一組範圍
            </Button>
            <span>
              {offset + 1}–{offset + items.length} / {task.totalChunks}
            </span>
            <Button
              className="btn small"
              variant="outline"
              disabled={next === null}
              onClick={() => {
                if (next !== null) setOffset(next);
              }}
            >
              下一組範圍
            </Button>
          </div>
        </>
      )}
    </Disclosure>
  );
}
