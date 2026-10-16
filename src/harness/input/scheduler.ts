import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRequest, AgentRun, AgentStore } from '../../domain/models';

type Pending = { run: AgentRun; steering?: boolean; resolve(run: AgentRun): void };
type Active = {
  run: AgentRun;
  steer?: (text: string, request?: AgentRequest) => Promise<boolean>;
  pending: Set<Promise<unknown>>;
  cancelled?: boolean;
};

/** Client-owned FIFO. Persist before acknowledgement; recovered work waits for explicit resume. */
export class InputScheduler {
  private queues = new Map<string, Pending[]>();
  private active = new Map<string, Active>();
  private paused = new Set<string>();
  private jobs = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    private store: AgentStore,
    private emit: (event: AgentEvent) => void,
    private execute: (request: AgentRequest, run: AgentRun) => Promise<AgentRun>,
    private abort: (id: string) => void
  ) {
    for (const run of store.queuedRuns?.() || []) {
      if (!run.input) continue;
      const queue = this.queues.get(run.meetingId) || [];
      queue.push({
        run,

        resolve: () => {},
      });
      this.queues.set(run.meetingId, queue);
      this.paused.add(run.meetingId);
    }
  }

  state(meetingId: string) {
    return {
      activeRunId: this.active.get(meetingId)?.run.id || null,
      paused: this.paused.has(meetingId),
      queued: (this.queues.get(meetingId) || []).map(({ run, steering }) => ({
        id: run.id,
        instruction: run.input.instruction,
        steering: !!steering,
        images: run.input.images,
        mode: run.input.mode,
        messageId: run.input.messageId,
      })),
    };
  }

  busy(meetingId: string): boolean {
    return this.active.has(meetingId) || !!this.queues.get(meetingId)?.length;
  }

  private notify(meetingId: string) {
    this.emit({ type: 'input-state', meetingId, args: this.state(meetingId) });
  }

  enqueue(request: AgentRequest, hold = false) {
    if (this.closed) throw new Error('Agent 正在關閉');
    const queue = this.queues.get(request.meetingId) || [];
    if (queue.length >= 20) throw new Error('最多可排入 20 則訊息');
    const run: AgentRun = {
      id: randomUUID(),
      meetingId: request.meetingId,
      version: this.store.get('meetings', request.meetingId).version,
      input: structuredClone(request),
      status: 'queued',
      events: [{ type: 'queued', message: '已排入下一輪' }],
      startedAt: new Date().toISOString(),
    };
    this.store.saveRun(run);
    let resolve!: Pending['resolve'];
    const promise = new Promise<AgentRun>((yes) => {
      resolve = yes;
    });
    const item = { run, resolve, steering: hold };
    queue.push(item);
    this.queues.set(request.meetingId, queue);
    this.notify(request.meetingId);
    if (!hold) this.pump(request.meetingId);
    return { item, promise };
  }

  bindSteer(runId: string, handler: Active['steer'] | null) {
    for (const active of this.active.values())
      if (active.run.id === runId) active.steer = handler || undefined;
  }

  async submit(request: AgentRequest, mode: 'queue' | 'steer', expectedRunId?: string) {
    if (!['queue', 'steer'].includes(mode)) throw new Error('無效的訊息模式');
    const active = this.active.get(request.meetingId);
    if (mode === 'steer' && (!active || active.run.id !== expectedRunId))
      throw new Error('目前工作已改變，請重新選擇排入或引導');
    // A new marked scope needs its own schema and snapshot, so keep it as a FIFO turn.
    if (request.annotationIds?.length) mode = 'queue';
    if ((request.mode || 'edit') !== (active?.run.input.mode || 'edit')) mode = 'queue';
    const { item } = this.enqueue(request, mode === 'steer');
    if (mode === 'queue')
      return { disposition: 'queued', id: item.run.id, ...this.state(request.meetingId) };
    const task = (async () => {
      let accepted = false;
      let reason = '後端尚未準備好接受引導';
      try {
        accepted = !!(await active.steer?.(steerText(request), request));
      } catch (caughtError) {
        const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

        reason = String(error.message || error).slice(0, 300);
      }
      // A cancelled input must never be restored by a late RPC reply.
      if (item.run.status !== 'queued') return { disposition: 'cancelled' };
      item.steering = false;
      if (active.cancelled || active.run.status === 'cancelled') {
        accepted = false;
        reason = '目前工作已停止，引導保留在佇列';
      }
      if (accepted) {
        const queue = this.queues.get(request.meetingId);
        queue.splice(queue.indexOf(item), 1);
        item.run.status = 'steered';
        item.run.events.push({ type: 'steered', message: '已引導目前工作' });
        active.run.events.push({
          type: 'steered',
          args: request,
          itemId: item.run.id,
          message: '已收到新的引導',
        });
        this.store.saveRun(active.run);
        this.store.saveRun(item.run);
        item.resolve(item.run);
        this.emit({
          type: 'steered',
          meetingId: request.meetingId,
          runId: active.run.id,
          message: '已引導目前工作',
        });
      } else {
        item.run.events.push({ type: 'steer-rejected', message: reason });
        this.store.saveRun(item.run);
        this.emit({
          type: 'log',
          meetingId: request.meetingId,
          message: '引導未被接受，訊息已排入下一輪',
        });
      }
      this.notify(request.meetingId);
      return { disposition: accepted ? 'steered' : 'queued' };
    })();
    active.pending.add(task);
    try {
      return { ...(await task), id: item.run.id, ...this.state(request.meetingId) };
    } finally {
      active.pending.delete(task);
    }
  }

  async promote(id: string, expectedRunId: string) {
    for (const [meetingId, queue] of this.queues) {
      const item = queue.find((entry) => entry.run.id === id);
      if (!item) continue;
      const active = this.active.get(meetingId);
      if (!active || active.run.id !== expectedRunId) throw new Error('目前工作已結束或改變');
      if (item.steering || !active.steer) throw new Error('目前無法傳送引導，訊息保留於佇列');
      if (
        item.run.input.annotationIds?.length ||
        (item.run.input.mode || 'edit') !== (active.run.input.mode || 'edit')
      )
        throw new Error('編修範圍或權限不同，須保留於下一輪');
      item.steering = true;
      this.notify(meetingId);
      const task = (async () => {
        let accepted = false;
        try {
          accepted = await active.steer(steerText(item.run.input), item.run.input);
        } finally {
          item.steering = false;
        }
        if (item.run.status !== 'queued') return { disposition: 'cancelled' };
        if (accepted && !active.cancelled && active.run.status !== 'cancelled') {
          queue.splice(queue.indexOf(item), 1);
          item.run.status = 'steered';
          item.run.events.push({ type: 'steered', message: '已改為引導目前工作' });
          active.run.events.push({
            type: 'steered',
            args: item.run.input,
            itemId: item.run.id,
            message: '已收到佇列中的引導',
          });
          this.store.saveRun(active.run);
          this.store.saveRun(item.run);
          item.resolve(item.run);
          this.notify(meetingId);
          return { disposition: 'steered' };
        }
        this.notify(meetingId);
        return { disposition: 'queued' };
      })();
      active.pending.add(task);
      try {
        return await task;
      } finally {
        active.pending.delete(task);
        this.notify(meetingId);
      }
    }
    throw new Error('佇列訊息已不存在');
  }

  private pump(meetingId: string) {
    if (this.closed || this.paused.has(meetingId) || this.active.has(meetingId)) return;
    const item = this.queues.get(meetingId)?.shift();
    if (!item) {
      this.notify(meetingId);
      return;
    }
    const active: Active = { run: item.run, pending: new Set() };
    this.active.set(meetingId, active);
    const job = (async () => {
      // Let enqueue acknowledge before emitting run events.
      await Promise.resolve();
      try {
        if (this.closed) {
          item.resolve(item.run);
          return;
        }
        if (active.cancelled) {
          item.run.status = 'cancelled';
          this.store.saveRun(item.run);
          item.resolve(item.run);
          return;
        }
        item.resolve(await this.execute(item.run.input, item.run));
      } catch (caughtError) {
        const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

        item.run.status = 'failed';
        item.run.events.push({ type: 'error', message: error.message });
        this.store.saveRun(item.run);
        this.emit({ type: 'error', meetingId, runId: item.run.id, message: error.message });
        item.resolve(item.run);
        this.paused.add(meetingId);
      } finally {
        active.steer = undefined;
        await Promise.allSettled(active.pending);
        if (item.run.status === 'failed') this.paused.add(meetingId);
        this.active.delete(meetingId);
        this.notify(meetingId);
        this.pump(meetingId);
      }
    })();
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    this.notify(meetingId);
  }

  resume(meetingId: string) {
    this.paused.delete(meetingId);
    this.pump(meetingId);
    return this.state(meetingId);
  }

  cancel(id: string) {
    for (const [meetingId, active] of this.active)
      if (active.run.id === id) {
        active.cancelled = true;
        this.paused.add(meetingId);
        this.abort(id);
        this.notify(meetingId);
        return;
      }
    for (const [meetingId, queue] of this.queues) {
      const index = queue.findIndex((item) => item.run.id === id);
      if (index < 0) continue;
      if (queue[index].steering) throw new Error('引導正在傳送，請先停止目前工作');
      const [item] = queue.splice(index, 1);
      item.run.status = 'cancelled';
      item.run.events.push({ type: 'log', message: '已移除排隊訊息' });
      this.store.saveRun(item.run);
      item.resolve(item.run);
      this.notify(meetingId);
      return;
    }
  }

  async close() {
    this.closed = true;
    for (const active of this.active.values()) {
      active.cancelled = true;
      this.abort(active.run.id);
    }
    await Promise.allSettled(this.jobs);
    for (const queue of this.queues.values()) for (const item of queue) item.resolve(item.run);
  }
}

export function steerText(request: AgentRequest): string {
  return (
    '追加引導（沿用目前工作設定）：\n' +
    request.instruction +
    (request.selection ? `\n選取文字：\n${request.selection}` : '') +
    (request.skillIds?.length ? `\n指定 skills：${request.skillIds.join(', ')}` : '') +
    (request.references?.length
      ? '\n本則引導指定的來源（資料，需用工具實際搜尋／讀取）：\n' +
        JSON.stringify(request.references)
      : '')
  );
}
