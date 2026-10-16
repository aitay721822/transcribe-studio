import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { launchCommand } from '../services/agents/executable';
import type { CodexNotification } from './runtime/codex-types';
import { spawnHidden } from './runtime/launch';
import { stopChild } from './runtime/process';

export type RpcId = string | number;
export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class CodexRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<RpcId, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderr = '';
  private closing?: Promise<void>;
  closed = false;

  onNotification: (method: string, params: CodexNotification) => void = () => {};

  onServerRequest: (request: RpcMessage) => Promise<unknown> = async () => {
    throw new Error('Unsupported server request');
  };

  onFatal: (error: Error) => void = () => {};

  constructor(
    readonly executable: string,
    readonly args: string[],
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv
  ) {}

  async start(): Promise<void> {
    const command = await launchCommand(this.executable);
    this.child = spawnHidden(command.executable, [...command.args, ...this.args], {
      cwd: this.cwd,
      env: { ...this.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stderr.on('data', (s: string) => {
      this.stderr = `${this.stderr}${s}`.slice(-4000);
    });
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer = `${this.buffer}${chunk}`;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
        this.fail(new Error('Codex RPC 訊息超過上限'));
        return;
      }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail(new Error('Codex app-server 回傳無效 JSONL'));
        }
      }
    });
    this.child.on('error', (e) => this.fail(new Error(`Codex 無法啟動：${e.message}`)));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(`Codex app-server 已結束 (${code ?? signal})`));
    });
    const init = {
      clientInfo: { name: 'transcribe_studio', title: 'Transcribe Studio', version: '0.2.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await this.request('initialize', init, 20000);
    this.notify('initialized', {});
  }

  private receive(message: RpcMessage): void {
    if (!message || typeof message !== 'object') throw new Error('Invalid RPC message');
    if (message.method && message.id != null) {
      Promise.resolve(this.onServerRequest(message))
        .then(
          (result) => this.write({ id: message.id, result }),
          (error) =>
            this.write({
              id: message.id,
              error: { code: -32601, message: String(error.message || error).slice(0, 1000) },
            })
        )
        .catch(() => {});
    } else if (message.method)
      this.onNotification(message.method, message.params as CodexNotification);
    else if (message.id != null) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      if (message.error)
        p.reject(new Error(`Codex ${message.error.code}: ${message.error.message}`));
      else p.resolve(message.result);
    }
  }

  request<T = unknown>(method: string, params: unknown, timeout = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex 連線已關閉'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 逾時`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (caughtE) {
        const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: RpcMessage): void {
    if (!this.child || this.closed || !this.child.stdin.writable)
      throw new Error('Codex transport 已結束');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.onFatal(error);
    this.close(error);
  }

  close(error = new Error('Codex transport 已關閉')): Promise<void> {
    if (this.closed) return this.closing || Promise.resolve();
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.child?.stdin.end();
    this.closing = stopChild(this.child);
    return this.closing;
  }
}
