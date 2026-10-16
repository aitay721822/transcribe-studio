import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkspaceRoot } from '../../domain/models';
import type {
  ScanStats,
  WorkspaceArgs,
  WorkspaceOptions,
  WorkspaceResults,
} from '../../domain/workspace';

let worker: Worker;
const pending = new Map<
  string,
  { finish(error: unknown, value?: unknown): void; onProgress?: (stats: ScanStats) => void }
>();

function entryPath() {
  let directory = __dirname;
  for (let i = 0; i < 5; i++, directory = path.dirname(directory)) {
    const file = path.join(directory, 'services', 'workspace', 'worker.cjs');
    if (fs.existsSync(file)) return file;
  }
  throw new Error('找不到檔案搜尋 Worker，請重新建置應用程式');
}

function start() {
  if (worker) return worker;
  const created = new Worker(entryPath());
  worker = created;
  created.on(
    'message',
    (event: {
      id: string;
      error?: string;
      progress?: ScanStats;
      result?: WorkspaceResults[keyof WorkspaceResults];
    }) => {
      const job = pending.get(event.id);
      if (!job) {
        if (event.result && 'nextCursor' in event.result && event.result.nextCursor)
          releaseCursor(event.result.nextCursor);
        return;
      }
      if (event.progress) {
        job.onProgress?.(event.progress);
        return;
      }
      job.finish(event.error ? new Error(event.error) : null, event.result);
    }
  );

  const fail = (error: Error) => {
    if (worker === created) {
      worker = undefined;
      for (const job of [...pending.values()]) job.finish(error);
    }
  };

  created.on('error', fail);
  created.on('exit', () => fail(new Error('檔案搜尋 Worker 已結束，請重新搜尋')));
  created.unref();
  return created;
}

export async function workspaceRequest<K extends keyof WorkspaceResults>(
  kind: K,
  roots: WorkspaceRoot[],
  args: WorkspaceArgs,
  options: WorkspaceOptions = {}
): Promise<WorkspaceResults[K]> {
  options.signal?.throwIfAborted();
  const target = start(),
    id = randomUUID();
  target.ref();
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;

    const finish = (error: unknown, value?: unknown) => {
      if (!pending.delete(id)) return;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (!pending.size) target.unref();
      error ? reject(error) : resolve(value as WorkspaceResults[K]);
    };

    const abort = () => {
      target.postMessage({ id, cancel: true });
      finish(options.signal?.reason || new Error('檔案工作已取消'));
    };

    pending.set(id, { finish, onProgress: options.onProgress });
    options.signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      target.postMessage({ id, cancel: true });
      finish(new Error('檔案讀取逾時，請檢查資料夾連線並重新搜尋'));
    }, 45000);
    timeout.unref();
    target.postMessage({ id, kind, roots, args });
  });
}

export function releaseCursor(token: string) {
  if (token && worker) worker.postMessage({ release: token });
}

export async function closeWorkspace() {
  const current = worker;
  for (const job of [...pending.values()]) job.finish(new Error('檔案服務已關閉'));
  worker = undefined;
  if (current) await current.terminate();
}
