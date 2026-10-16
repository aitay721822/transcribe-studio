import { type ChildProcess, spawn } from 'node:child_process';

const closing = new WeakMap<ChildProcess, Promise<void>>();

/** Wait for pipes to close as well as killing npm wrappers and their native children. */
export function stopChild(child?: ChildProcess): Promise<void> {
  if (!child?.pid) return Promise.resolve();
  const pending = closing.get(child);
  if (pending) return pending;
  const stopped = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('close', () => resolve());
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        child.kill('SIGKILL');
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  });
  closing.set(child, stopped);
  return stopped;
}
