import type { ComponentProps } from 'react';
import { icon } from '../components/icons';

/** Keep native disclosure semantics while sharing the application's accordion appearance. */
export function Disclosure(props: ComponentProps<'details'>) {
  return <details data-slot="disclosure" {...props} />;
}

export function DisclosureTrigger({ children, ...props }: ComponentProps<'summary'>) {
  return (
    <summary data-slot="disclosure-trigger" {...props}>
      {children}
      {icon('down', 'disclosure-chevron')}
    </summary>
  );
}
