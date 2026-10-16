import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';

const preference = matchMedia('(prefers-reduced-motion: reduce)');
const ReducedMotion = createContext(false);

const subscribe = (changed: () => void) => {
  preference.addEventListener('change', changed);
  return () => preference.removeEventListener('change', changed);
};

export const useMotionPreference = () => useContext(ReducedMotion);

export function MotionProvider({ children }: { children: ReactNode }) {
  const reduced = useSyncExternalStore(subscribe, () => preference.matches);
  return (
    <ReducedMotion value={reduced}>
      <MotionConfig
        reducedMotion={reduced ? 'always' : 'never'}
        transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <LazyMotion features={domAnimation} strict>
          {children}
        </LazyMotion>
      </MotionConfig>
    </ReducedMotion>
  );
}
