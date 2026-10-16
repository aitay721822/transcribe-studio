import * as m from 'motion/react-m';
import type { ReactNode } from 'react';
import { useMotionPreference } from './provider';

/** Re-renders preserve inputs; only mounting a new keyed view starts its entrance. */
export function Reveal({
  children,
  className,
  distance = 6,
}: {
  children: ReactNode;
  className?: string;
  distance?: number;
}) {
  const reduced = useMotionPreference();
  return (
    <m.div
      className={className}
      data-motion="reveal"
      initial={reduced ? false : { opacity: 0, y: distance }}
      animate={{ opacity: 1, y: 0 }}
    >
      {children}
    </m.div>
  );
}
