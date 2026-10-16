import { type ChildProcess, spawn } from 'node:child_process';

interface StopOptions {
  platform?: string;
  group?: boolean;
  graceMs?: number;
  deadlineMs?: number;
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
}
const closing = new WeakMap<ChildProcess, Promise<void>>();

/** Bound cancellation even when a CLI ignores SIGTERM or retains pipes. */
export function stopChild(child?: ChildProcess, options: StopOptions = {}): Promise<void> {
  if (!child?.pid) return Promise.resolve();
  const pending = closing.get(child);
  if (pending) return pending;
  const platform = options.platform || process.platform;
  const stopped = new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      clearTimeout(deadline);
      child.removeListener('close', finish);
      resolve();
    };

    const signal = (name: NodeJS.Signals) => {
      if (platform !== 'win32' && options.group !== false) {
        try {
          (options.killGroup || process.kill)(-child.pid, name);
          return;
        } catch {
          // A process may have already left the group.
        }
      }
      try {
        child.kill(name);
      } catch {
        /* Already gone. */
      }
    };

    const force = setTimeout(() => signal('SIGKILL'), options.graceMs ?? 1000);
    const deadline = setTimeout(() => {
      signal('SIGKILL');
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish();
    }, options.deadlineMs ?? 3000);
    child.once('close', finish);
    const pipesClosed = [child.stdin, child.stdout, child.stderr].every(
      (stream) => !stream || stream.destroyed
    );
    if ((child.exitCode !== null || child.signalCode !== null) && pipesClosed) {
      finish();
      return;
    }
    if (platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => signal('SIGKILL'));
      killer.once('exit', (code) => {
        if (code) signal('SIGKILL');
      });
    } else signal('SIGTERM');
  });
  closing.set(child, stopped);
  return stopped;
}
