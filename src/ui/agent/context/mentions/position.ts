import { type CSSProperties, useLayoutEffect, useState } from 'react';

export function useMentionPosition(open: boolean): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = document.querySelector('.agent-input-wrap');
    if (!anchor) return;
    let frame = 0;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(rect.width, innerWidth - 24);
      const above = Math.max(0, Math.min(rect.top - 12, innerHeight - 24));
      const below = Math.max(0, innerHeight - rect.bottom - 12);
      const up = above >= below;
      setStyle({
        visibility: 'visible',
        width,
        left: Math.max(12, Math.min(rect.left, innerWidth - width - 12)),
        ...(up
          ? { bottom: Math.max(12, innerHeight - rect.top + 8), top: 'auto' }
          : { top: Math.max(12, rect.bottom + 8), bottom: 'auto' }),
        maxHeight: Math.max(80, Math.min(460, innerHeight * 0.65, up ? above : below)),
      });
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    for (const selector of ['.agent-composer', '.agent-pane', '.workspace']) {
      const parent = anchor.closest(selector);
      if (parent) observer.observe(parent);
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open]);
  return style;
}
