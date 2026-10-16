import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentAuth, agentModel } from '../../domain/agents/auth';
import type { ImageData } from '../../domain/models';
import { notesSchema, parseNotes } from '../../harness/prompt';
import { agentEnv, agentHome } from '../../services/agents/config';
import { agentError } from '../../services/agents/errors';
import { executableCandidates } from '../../services/agents/executable';
import { probeLogin } from '../../services/agents/login';
import { meetingGateway } from '../../transport/claude/gateway';
import { ClaudeProcess } from '../../transport/claude/process';
import type { HarnessAdapter, HarnessContext } from '../contracts';

export async function findClaudeExecutable(configured = '') {
  const [local] = await executableCandidates('claude', configured);
  if (local) return local;
  throw new Error(
    '找不到 Claude Code CLI，請先安裝 Claude Code，再重新偵測或指定 CLI 路徑。CLI 登入模式另需執行 claude auth login。'
  );
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude';

  constructor(
    private processFactory = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
      new ClaudeProcess(file, args, cwd, env)
  ) {}

  async execute(ctx: HarnessContext): Promise<string> {
    const llm = ctx.settings.llm;
    const cli = agentAuth(llm, 'claude') === 'cli';
    const model = agentModel(llm, 'claude');
    const executable = await findClaudeExecutable(llm.claudePath);
    const home = agentHome(llm, 'claude', ctx.runtimeDir, ctx.project.id);
    const cwd = path.join(ctx.runtimeDir, 'workspaces', ctx.project.id);
    await fs.mkdir(cwd, { recursive: true });
    if (!cli) await fs.mkdir(home, { recursive: true });
    ctx.signal.throwIfAborted();
    const login = cli ? await probeLogin('claude', executable) : null;
    if (login?.status === 'signed-out')
      throw new Error('Claude CLI 尚未登入，請在終端機執行 claude auth login，再重新測試。');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          protocol: 'cli-p-v1',
          home,
          executable,
          auth: cli ? login?.identity : llm.claudeKey,
          model,
          roots: ctx.project.roots,
          tools: ctx.tools.specs(),
          instructions: ctx.instructions,
          schema: ctx.result?.schema || notesSchema,
        })
      )
      .digest('hex');
    const saved = ctx.meeting.agentSessions?.claude;
    const gateway = await meetingGateway(ctx.tools, ctx.signal);
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify(gateway.config),
      '--setting-sources',
      cli ? 'user' : '',
      '--permission-mode',
      'default',
      '--disable-slash-commands',
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--allowedTools',
      'mcp__meeting__meeting_tool',
      '--max-turns',
      String(ctx.maxSteps),
      '--system-prompt',
      ctx.instructions +
        '\n可用工具（透過 mcp__meeting__meeting_tool）：' +
        JSON.stringify(ctx.tools.specs()) +
        '\n最終輸出符合 JSON Schema。',
      '--json-schema',
      JSON.stringify(ctx.result?.schema || notesSchema),
    ];
    if (model) args.push('--model', model);
    if (ctx.ephemeral) args.push('--no-session-persistence');
    else if (
      (!cli || login?.status === 'signed-in') &&
      saved?.fingerprint === fingerprint &&
      saved.home === home
    )
      args.push('--resume', saved.id);
    const child = this.processFactory(executable, args, cwd, agentEnv(llm, 'claude', home));
    let resolve!: (text: string) => void, reject!: (error: Error) => void;
    const completed = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completed.catch(() => {});
    child.onError = reject;
    let compactionId: string;
    child.onMessage = (message) => {
      if (
        message.type === 'system' &&
        message.subtype === 'status' &&
        (message.status === 'compacting' || message.compact_result === 'failed')
      )
        ctx.emit({
          type: 'compaction',
          callId: (compactionId ||= randomUUID()),
          status: message.compact_result === 'failed' ? 'error' : 'running',
          message: message.compact_error || 'Claude 正在壓縮原生上下文',
          args: { native: true },
        });
      if (message.compact_result === 'failed') compactionId = undefined;
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        ctx.emit({
          type: 'compaction',
          callId: compactionId || randomUUID(),
          status: 'completed',
          message: 'Claude 原生上下文壓縮完成',
          args: message.compact_metadata,
        });
        compactionId = undefined;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        if (!ctx.ephemeral) ctx.bindSession({ id: message.session_id, fingerprint, home });
        ctx.emit({ type: 'log', message: 'Claude Code 正在整理會議資料' });
      }
      if (message.type === 'result') {
        // CLI emits a result for each turn. Wait for queued input to be consumed.
        if (child.awaitingInput && message.subtype === 'success' && !message.is_error) return;
        ctx.bindSteer?.(null);
        if (message.subtype !== 'success' || message.is_error) {
          reject(
            new Error(
              'Claude CLI 執行失敗：' +
                (message.errors?.join('; ') || message.result || message.subtype)
            )
          );
        } else {
          try {
            resolve(
              (ctx.result?.parse || parseNotes)(
                message.structured_output
                  ? JSON.stringify(message.structured_output)
                  : message.result
              )
            );
          } catch (caughtError) {
            const error =
              caughtError instanceof Error ? caughtError : new Error(String(caughtError));

            reject(error);
          }
        }
      }
    };

    const abort = () => {
      reject(ctx.signal.reason || new Error('Claude 已停止'));
      void child.close();
    };

    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      ctx.signal.throwIfAborted();
      await child.start();

      const content = (text: string, images: ImageData[] = []) =>
        images.length
          ? [
              { type: 'text', text },
              ...images.map((i) => ({
                type: 'image',
                source: { type: 'base64', media_type: i.mime, data: i.dataUrl.split(',')[1] },
              })),
            ]
          : text;

      void child.send(content(ctx.prompt, ctx.images));
      ctx.bindSteer?.((text, images) => child.send(content(text, images)));
      ctx.signal.throwIfAborted();
      return await completed;
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      throw ctx.signal.aborted ? ctx.signal.reason : agentError(error, 'claude');
    } finally {
      ctx.bindSteer?.(null);
      ctx.signal.removeEventListener('abort', abort);
      await child.close();
      await gateway.close();
    }
  }
}
