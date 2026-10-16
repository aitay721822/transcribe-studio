import { Progress as ProgressPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './utils';

export function Progress({
  className,
  value = null,
  max = 100,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root>) {
  const maximum = Number.isFinite(max) && max > 0 ? max : 100;
  const current = value === null ? null : Math.max(0, Math.min(maximum, value));
  return (
    <ProgressPrimitive.Root
      {...props}
      data-slot="progress"
      className={cn('relative overflow-hidden rounded-full', className)}
      value={current}
      max={maximum}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        style={{ transform: `translateX(-${100 - ((current ?? 0) / maximum) * 100}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
