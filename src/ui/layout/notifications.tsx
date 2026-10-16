import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { useSyncExternalStore } from 'react';
import { icon } from '../components/icons';
import { useMotionPreference } from '../components/motion/provider';
import { renderNodeInto } from './roots';

interface Notification {
  id: number;
  message: string;
  error: boolean;
}
let notifications: Notification[] = [],
  sequence = 0,
  mounted = false;
const listeners = new Set<() => void>();

const publish = () => listeners.forEach((listener) => listener());

function dismiss(id: number) {
  notifications = notifications.filter((n) => n.id !== id);
  publish();
}

export function notify(message: string, error = false) {
  notifications = [
    ...notifications,
    {
      id: ++sequence,
      message,
      error,
    },
  ];
  const id = sequence;
  publish();
  if (!mounted) {
    mounted = true;
    renderNodeInto(document.getElementById('toasts'), <Notifications />);
  }
  setTimeout(() => dismiss(id), error ? 9000 : 4000);
}

function Notifications() {
  const reduced = useMotionPreference();
  const entries = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notifications
  );
  return (
    <AnimatePresence>
      {entries.map((n) => (
        <m.div
          className={`toast${n.error ? ' error' : ''}`}
          key={n.id}
          role="status"
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : 4 }}
          transition={{ duration: reduced ? 0 : 0.18 }}
        >
          <span>{n.message}</span>
          <button aria-label="關閉通知" onClick={() => dismiss(n.id)}>
            {icon('x')}
          </button>
        </m.div>
      ))}
    </AnimatePresence>
  );
}
