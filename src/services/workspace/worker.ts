import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import type { WorkspaceRoot } from '../../domain/models';
import type { ScanStats, WorkspaceArgs, WorkspaceEntry } from '../../domain/workspace';
import { integer, readPage, scanFile } from './content';
import { progressState, recordError, walk } from './traversal';

interface ScanSession {
  key: string;
  controller: AbortController;
  stats: ScanStats;
  iterator: AsyncGenerator<WorkspaceEntry, void, unknown>;
  updated: number;
  buffered?: IteratorResult<WorkspaceEntry, void>;
}

const sessions = new Map<string, ScanSession>(),
  running = new Map<string, AbortController>();
const ttl = 10 * 60000;

const discard = async (token: string) => {
  const session = sessions.get(token);
  sessions.delete(token);
  if (session) {
    session.controller.abort();
    await session.iterator.return();
  }
};

setInterval(() => {
  for (const [token, s] of sessions) if (Date.now() - s.updated > ttl) void discard(token);
}, 30000).unref();

async function* entries(
  kind: string,
  roots: WorkspaceRoot[],
  args: WorkspaceArgs,
  stats: ScanStats,
  signal: AbortSignal
) {
  const normalize = (text: string) => text.replaceAll('\\', '/').toLowerCase();

  for await (const file of walk(roots, stats, signal, {
    ...args,
    includeDirectories: kind === 'mentions',
  })) {
    if (!file) {
      yield null;
      continue;
    }
    if (kind === 'list' || kind === 'mentions') {
      yield !args.query ||
      normalize(`${kind === 'mentions' ? `${file.rootName}/` : ''}${file.relative}`).includes(
        normalize(args.query)
      )
        ? file
        : null;
    } else if (!args.pathQuery || normalize(file.relative).includes(normalize(args.pathQuery))) {
      try {
        yield* scanFile(roots, file, args.query, args.caseSensitive, stats, signal);
      } catch (caughtE) {
        const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

        signal.throwIfAborted();
        recordError(stats, file.relative, e);
        yield null;
      }
    } else yield null;
  }
}

parentPort.on(
  'message',
  async (message: {
    cancel?: boolean;
    release?: string;
    id: string;
    kind: string;
    roots: WorkspaceRoot[];
    args: WorkspaceArgs;
  }) => {
    if (message.cancel) {
      running.get(message.id)?.abort(new Error('檔案工作已取消'));
      return;
    }
    if (message.release) {
      await discard(message.release);
      return;
    }
    const { id, kind, roots, args } = message;
    let session: ScanSession;
    try {
      if (kind === 'read') {
        const controller = new AbortController();
        running.set(id, controller);
        parentPort.postMessage({ id, result: await readPage(roots, args, controller.signal) });
        return;
      }
      if (
        typeof args.query !== 'string' ||
        args.query.length > 200 ||
        (kind === 'search' && (!args.query || /[\r\n]/.test(args.query)))
      )
        throw new Error('搜尋須提供 1–200 字元的單行文字');
      if (
        (args.rootId && !roots.some((r) => r.id === args.rootId)) ||
        (args.directory && !args.rootId)
      )
        throw new Error('指定資料夾必須提供已授權的 rootId');
      const limit = integer(args.limit, kind === 'list' ? 100 : 20, 1, kind === 'list' ? 200 : 50);
      const key = JSON.stringify({
        kind,
        roots,
        query: args.query,
        pathQuery: args.pathQuery,
        caseSensitive: args.caseSensitive,
        rootId: args.rootId,
        directory: args.directory,
      });
      if (args.cursor) {
        const candidate = sessions.get(args.cursor);
        if (!candidate || candidate.key !== key || Date.now() - candidate.updated > ttl)
          throw new Error('搜尋游標已失效或不屬於此查詢／資料夾，請從第一頁重新搜尋');
        session = candidate;
        sessions.delete(args.cursor);
      } else {
        if (sessions.size + running.size >= 64)
          throw new Error('背景搜尋工作過多，請關閉其他檔案視窗後重試');
        const controller = new AbortController(),
          stats = progressState();
        session = {
          key,
          controller,
          stats,
          iterator: entries(kind, roots, args, stats, controller.signal),
          updated: Date.now(),
        };
      }
      running.set(id, session.controller);
      const values: WorkspaceEntry[] = [],
        start = Date.now();
      let complete = false,
        notified = 0,
        outputChars = 0;
      while (values.length < limit) {
        session.controller.signal.throwIfAborted();
        const entry = session.buffered || (await session.iterator.next());
        session.buffered = undefined;
        if (entry.done) {
          complete = true;
          break;
        }
        if (entry.value) {
          const size = JSON.stringify(entry.value).length;
          if (values.length && outputChars + size > 60000) {
            session.buffered = entry;
            break;
          }
          values.push(entry.value);
          outputChars += size;
        }
        const now = Date.now();
        if (now - notified >= 250) {
          parentPort.postMessage({ id, progress: session.stats });
          notified = now;
        }
        if (now - start >= 2000) break;
      }
      session.controller.signal.throwIfAborted();
      const nextCursor = complete ? null : randomUUID();
      if (nextCursor) {
        session.updated = Date.now();
        sessions.set(nextCursor, session);
      }
      parentPort.postMessage({
        id,
        result: {
          [kind === 'search' ? 'matches' : 'files']: values,
          nextCursor,
          complete,
          truncated: false,
          stats: session.stats,
          errors: session.stats.errors,
          cursorExpiresInSeconds: nextCursor ? ttl / 1000 : null,
        },
      });
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      if (session) {
        session.controller.abort();
        await session.iterator.return().catch(() => {});
      }
      parentPort.postMessage({ id, error: error.message });
    } finally {
      running.delete(id);
    }
  }
);
