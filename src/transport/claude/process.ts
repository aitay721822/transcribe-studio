import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { launchCommand } from '../../services/agents/executable';
import { spawnHidden } from '../runtime/launch';
import { stopChild } from '../runtime/process';
import type { ClaudeContent, ClaudeMessage } from './messages';

/** JSONL transport for the installed CLI; never invoke a shell or read auth files. */
export class ClaudeProcess {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderr = '';
  private stopping = false;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private pending = new Set<string>();

  get awaitingInput() {
    return this.pending.size > 0;
  }

  onMessage: (message: ClaudeMessage) => void = () => {};

  onError: (error: Error) => void = () => {};

  constructor(
    readonly executable: string,
    readonly args: string[],
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv
  ) {}

  async start() {
    const command = await launchCommand(this.executable);
    if (this.stopping) throw new Error('Claude 已停止');
    const child = (this.child = spawnHidden(command.executable, [...command.args, ...this.args], {
      cwd: this.cwd,
      env: this.env,
    }));
    this.exited = new Promise((resolve) => child.once('close', () => resolve()));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      this.stderr = `${this.stderr}${text}`.slice(-4000);
    });
    child.stdin.on('error', (error) => {
      if (!this.stopping) this.onError(error);
    });
    child.on('error', (error) => {
      if (!this.stopping) this.onError(error);
    });
    child.on('close', (code) => {
      this.pending.clear();
      if (!this.stopping) this.onError(new Error(`Claude CLI 已結束 (${code})。${this.stderr}`));
    });
    child.stdout.on('data', (chunk: string) => {
      this.buffer = `${this.buffer}${chunk}`;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
        this.onError(new Error('Claude CLI 串流超過上限'));
        return;
      }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'user' && message.uuid) {
            this.pending.delete(message.uuid);
          }
          this.onMessage(message);
        } catch {
          this.onError(new Error('Claude CLI 回傳無效 JSONL'));
        }
      }
    });
  }

  send(text: string | ClaudeContent[]): Promise<boolean> {
    if (this.stopping || !this.child?.stdin.writable) return Promise.resolve(false);
    const uuid = randomUUID();
    return new Promise((resolve) => {
      this.pending.add(uuid);
      this.child.stdin.write(
        `${JSON.stringify({
          type: 'user',
          uuid,
          session_id: '',
          message: { role: 'user', content: text },
          parent_tool_use_id: null,
        })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(uuid);
            resolve(false);
          } else resolve(true);
        }
      );
    });
  }

  async close() {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.pending.clear();
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    this.closing = stopChild(child);
    await this.closing;
  }
}
