import { Popover } from 'radix-ui';
import { useRef, useState } from 'react';
import type { Meeting } from '../../../domain/models';

const time = (value: number) => {
  const seconds = Math.max(0, Math.floor(value || 0));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};

export function sourceCitation(id: string, meeting?: Meeting) {
  const segment = meeting?.segments.find((s) => s.id === id || `片段:${s.id}` === id);
  return segment || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? { segment, id }
    : undefined;
}

export function SourceCitation({
  id,
  meeting,
  start,
  length,
}: {
  id: string;
  meeting?: Meeting;
  start: number;
  length: number;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const source = sourceCitation(id, meeting);
  const segment = source?.segment;
  const label = segment ? `逐字稿 ${time(segment.start)}` : '來源無法取得';
  return (
    <span
      className="citation-anchor"
      data-source-start={start}
      data-source-length={length}
      contentEditable={false}
      ref={anchor}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="source-citation"
            data-citation={id}
            aria-label={`查看來源：${label}`}
          >
            {label}
          </button>
        </Popover.Trigger>
        <Popover.Portal container={anchor.current?.closest('dialog') || undefined}>
          <Popover.Content
            className="source-popover"
            sideOffset={8}
            collisionPadding={16}
            aria-label="引用來源"
          >
            <div className="source-popover-heading">
              <strong>{segment ? '逐字稿來源' : '來源無法取得'}</strong>
              <Popover.Close aria-label="關閉來源">×</Popover.Close>
            </div>
            {segment ? (
              <>
                <small>
                  {meeting?.title} · {time(segment.start)}–{time(segment.end)}
                  {segment.speaker ? ` · ${segment.speaker}` : ''}
                  {segment.timing === 'provider' ? '' : ' · 時間約略'}
                </small>
                <p>{segment.text}</p>
              </>
            ) : (
              <p>目前會議找不到此片段，可能已刪除或來自其他會議。請重新核對來源。</p>
            )}
            <code>{id}</code>
            <Popover.Arrow className="source-popover-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
