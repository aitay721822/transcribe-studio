import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './utils';

// shadcn/ui's owned-source Radix Checkbox, using Studio's semantic theme tokens.
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn('peer shrink-0 rounded-[4px] border border-input shadow-xs', className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path className="checkbox-check" d="m5 12 4 4L19 6" />
          <path className="checkbox-mixed" d="M5 12h14" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/** Read the shared checkbox's public ARIA state when collecting an uncontrolled form. */
export function checkboxChecked(id: string): boolean {
  return document.getElementById(id)?.getAttribute('aria-checked') === 'true';
}
