import path from 'node:path';
import type { ConnectionEvent } from '../../domain/ipc';
import type { Settings } from '../../domain/models';
import { testAgent } from '../../services/diagnostics/agent';
import { AsrConnectionTests } from '../../services/diagnostics/asr';
import { connectionSettings, diagnosticError } from '../../services/diagnostics/settings';
import type { DesktopContext } from '../context';

export function registerDiagnostics(ctx: DesktopContext) {
  const drafts = new Map<string, Settings>(),
    jobs = new Map<
      string,
      { controller: AbortController; promise: Promise<Awaited<ReturnType<typeof testAgent>>> }
    >();

  const check = (id: string) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('測試識別無效');
  };

  const send = (id: string, event: ConnectionEvent) =>
    ctx.send('connection:event', {
      ...event,
      id,
      ...(event.message && drafts.has(id)
        ? { message: diagnosticError(event.message, drafts.get(id)) }
        : {}),
    });

  const asr = new AsrConnectionTests(send);
  ctx.handle('connection:asr-start', async (id, draft) => {
    check(id);
    if (drafts.has(id)) throw new Error('測試識別已在使用');
    if (ctx.recordings.size) throw new Error('請先結束錄音再測試');
    const settings = connectionSettings(draft, ctx.settingsInternal());
    drafts.set(id, settings);
    try {
      return await asr.start(id, settings);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      drafts.delete(id);
      throw new Error(diagnosticError(e, settings));
    }
  });
  ctx.handle('connection:asr-audio', (id, bytes) => asr.audio(id, bytes));
  ctx.handle('connection:asr-commit', (id) => asr.commit(id));
  ctx.handle('connection:rtc-signal', async (id, offer) => {
    try {
      return await asr.signal(id, offer);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      throw new Error(drafts.has(id) ? diagnosticError(e, drafts.get(id)) : String(e.message));
    }
  });
  ctx.handle('connection:rtc-event', (id, data) => asr.event(id, data));
  ctx.handle('connection:agent-test', async (id, draft) => {
    check(id);
    if (jobs.size || drafts.has(id)) throw new Error('Agent 測試正在執行');
    const settings = connectionSettings(draft, ctx.settingsInternal()),
      controller = new AbortController();
    drafts.set(id, settings);
    const timer = setTimeout(
      () => controller.abort(new Error('Agent 連線測試逾時（60 秒）')),
      60000
    );
    const promise = testAgent(settings, path.join(ctx.dataDir, 'runtime'), controller, (message) =>
      send(id, { type: 'log', message })
    );
    jobs.set(id, { controller, promise });
    try {
      return await promise;
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      throw new Error(
        diagnosticError(controller.signal.aborted ? controller.signal.reason : e, settings)
      );
    } finally {
      clearTimeout(timer);
      jobs.delete(id);
      drafts.delete(id);
    }
  });
  ctx.handle('connection:stop', async (id, graceful = true) => {
    jobs.get(id)?.controller.abort(new Error('連線測試已取消'));
    await asr.stop(id, !!graceful);
    drafts.delete(id);
  });

  const close = async () => {
    const closingIds = [...drafts.keys()];
    for (const job of jobs.values()) job.controller.abort(new Error('程式關閉'));
    await Promise.allSettled([asr.close(), ...[...jobs.values()].map((job) => job.promise)]);
    for (const id of closingIds) drafts.delete(id);
  };

  ctx.win.webContents.on(
    'did-start-navigation',
    (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) void close();
    }
  );
  return { close };
}
