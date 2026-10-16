import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './utils';

export function Slider({
  className,
  value,
  defaultValue = [0],
  'aria-label': label,
  formatValue,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root> & { formatValue?(value: number): string }) {
  const positions = value ?? defaultValue;
  return (
    <SliderPrimitive.Root
      {...props}
      data-slot="slider"
      className={cn('relative flex touch-none select-none items-center', className)}
      value={value}
      defaultValue={defaultValue}
    >
      <SliderPrimitive.Track data-slot="slider-track">
        <SliderPrimitive.Range data-slot="slider-range" />
      </SliderPrimitive.Track>
      {positions.map((position, index) => (
        <SliderPrimitive.Thumb
          key={index}
          data-slot="slider-thumb"
          aria-label={positions.length > 1 ? `${label} ${index + 1}` : label}
          aria-valuetext={formatValue?.(position)}
        />
      ))}
    </SliderPrimitive.Root>
  );
}
