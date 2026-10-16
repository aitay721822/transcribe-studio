import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentAuth, agentModel } from '../../domain/agents/auth';
import { notesSchema, parseNotes } from '../../harness/prompt';
import { agentEnv, agentHome, codexArgs } from '../../services/agents/config';
import { agentError } from '../../services/agents/errors';
import { executableCandidates } from '../../services/agents/executable';
import { CodexRpcClient } from '../../transport/codex-rpc';
import type {
  CodexAccount,
  CodexConfiguration,
  CodexToolRequest,
} from '../../transport/runtime/codex-types';
import type { HarnessAdapter, HarnessContext } from '../contracts';

export async function findCodexExecutable(configured = ''): Promise<string> {
  const candidates = await executableCandidates('codex', configured);
  for (const file of candidates) {
    try {
      if ((await fs.stat(file)).isFile()) return path.resolve(file);
    } catch {}
  }
  throw new Error('找不到 Codex CLI，請指定 codex.exe 路徑或安裝 Codex CLI。');
}

/** Optional app-server adapter. There is no Codex dependency in the coordinator's contract. */
export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex';

  async execute(ctx: HarnessContext): Promise<string> {
    const llm = ctx.settings.llm;
    const cli = agentAuth(llm, 'codex') === 'cli';
    const model = agentModel(llm, 'codex');
    const home = agentHome(llm, 'codex', ctx.runtimeDir, ctx.project.id);
    const cwd = path.join(ctx.runtimeDir, 'workspaces', ctx.project.id);
    if (!cli) await fs.mkdir(home, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    const executable = await findCodexExecutable(ctx.settings.llm.codexPath);
    ctx.signal.throwIfAborted();
    const rpc = new CodexRpcClient(executable, codexArgs, cwd, agentEnv(llm, 'codex', home));
    let threadId = '';
    let turnId = '';
    let final = '';
    let resolve!: (text: string) => void;
    let reject!: (e: Error) => void;
    const completed = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    completed.catch(() => {});
    rpc.onFatal = reject;
    rpc.onNotification = (method, p) => {
      if (p?.threadId !== threadId || (p.turnId && turnId && p.turnId !== turnId)) return;
      if (method === 'turn/started') {
        turnId = p.turn.id;
        ctx.bindTurn?.(turnId);
      }
      if (
        ['item/started', 'item/completed'].includes(method) &&
        p.item?.type === 'contextCompaction'
      )
        ctx.emit({
          type: 'compaction',
          callId: p.item.id,
          status: method === 'item/started' ? 'running' : 'completed',
          message:
            method === 'item/started' ? 'Codex 正在壓縮原生上下文' : 'Codex 原生上下文壓縮完成',
          args: { native: true, itemId: p.item.id },
        });
      if (
        method === 'item/completed' &&
        p.item?.type === 'agentMessage' &&
        p.item.phase !== 'commentary'
      )
        final = p.item.text;
      if (method === 'turn/completed') {
        ctx.bindSteer?.(null);
        if (p.turn.status === 'completed') resolve(final);
        else reject(new Error(p.turn.error?.message || `Codex turn ${p.turn.status}`));
      }
    };
    rpc.onServerRequest = async (message) => {
      const p = message.params as CodexToolRequest;
      if (
        p?.threadId !== threadId ||
        (p.turnId && turnId && p.turnId !== turnId) ||
        ctx.signal.aborted
      )
        throw new Error('工具呼叫不屬於目前工作階段');
      if (message.method === 'item/tool/call') {
        try {
          return {
            success: true,
            contentItems: [
              {
                type: 'inputText',
                text: JSON.stringify(await ctx.tools.call(p.tool, p.arguments)),
              },
            ],
          };
        } catch (caughtError) {
          const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

          return {
            success: false,
            contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.message }) }],
          };
        }
      }
      if (
        [
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'execCommandApproval',
          'applyPatchApproval',
        ].includes(message.method)
      )
        return { decision: 'decline' };
      if (message.method === 'item/permissions/requestApproval')
        return { permissions: {}, scope: 'turn' };
      if (message.method === 'mcpServer/elicitation/request')
        return { action: 'decline', content: null, _meta: null };
      if (message.method === 'item/tool/requestUserInput')
        return {
          answers: Object.fromEntries(
            (p.questions || []).map((q) => [
              q.id,
              { answers: ['請將缺少的資訊標記為待確認，完成修訂提案。'] },
            ])
          ),
        };
      throw new Error(`未支援的 Codex request：${message.method}`);
    };

    const abort = () => {
      reject(ctx.signal.reason || new Error('Agent 已停止'));
      if (threadId && turnId)
        rpc
          .request('turn/interrupt', { threadId, turnId }, 1000)
          .finally(() => rpc.close())
          .catch(() => {});
      else rpc.close();
    };

    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      ctx.signal.throwIfAborted();
      await rpc.start();
      ctx.signal.throwIfAborted();
      const account = cli
        ? await rpc.request<CodexAccount>('account/read', { refreshToken: false })
        : null;
      if (cli && !account.account && account.requiresOpenaiAuth)
        throw new Error('Codex CLI 尚未登入，請在終端機執行 codex login，再重新測試。');
      const inherited = cli
        ? await rpc.request<CodexConfiguration>('config/read', { includeLayers: false })
        : null;
      const specs = ctx.tools.specs().map((t) => ({ type: 'function', ...t }));
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            roots: ctx.project.roots,
            specs,
            model: model || inherited?.config?.model,
            home,
            auth: cli ? account.account : 'api',
            provider: cli ? inherited?.config?.model_provider : llm.baseUrl,
            key: cli ? undefined : llm.apiKey,
            executable,
            instructions: ctx.instructions,
            schema: ctx.result?.schema || notesSchema,
          })
        )
        .digest('hex');
      const config = cli
        ? {
            mcp_servers: Object.fromEntries(
              Object.keys(inherited?.config?.mcp_servers || {}).map((name) => [
                name,
                { enabled: false },
              ])
            ),
          }
        : {
            model_providers: {
              studio: {
                name: 'Transcribe Studio',
                base_url: llm.baseUrl,
                env_key: 'STUDIO_CODEX_API_KEY',
                wire_api: 'responses',
                requires_openai_auth: false,
                supports_websockets: false,
              },
            },
          };
      const params = {
        ...(model ? { model } : {}),
        ...(!cli ? { modelProvider: 'studio' } : {}),
        cwd,
        runtimeWorkspaceRoots: ctx.project.roots.map((r) => r.path),
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        developerInstructions: `${ctx.instructions}\n最後依本輪 outputSchema 回傳 JSON。`,
        config,
      };
      const saved = ctx.meeting.agentSessions?.codex;
      const thread =
        saved?.fingerprint === fingerprint && saved.home === home && !ctx.ephemeral
          ? await rpc.request<{ thread: { id: string } }>('thread/resume', {
              ...params,
              threadId: saved.id,
            })
          : await rpc.request<{ thread: { id: string } }>('thread/start', {
              ...params,
              dynamicTools: specs,
              ephemeral: !!ctx.ephemeral,
            });
      threadId = thread.thread?.id;
      if (!threadId) throw new Error('Codex 未回傳 thread id');
      ctx.bindSession({ id: threadId, fingerprint, home });
      ctx.emit({ type: 'log', message: 'Codex 正在整理會議資料' });
      ctx.signal.throwIfAborted();
      const started = await rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId,
        cwd,
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        input: [
          { type: 'text', text_elements: [], text: ctx.prompt },
          ...(ctx.images || []).map((i) => ({ type: 'image', url: i.dataUrl })),
        ],
        outputSchema: ctx.result?.schema || notesSchema,
      });
      turnId = started.turn.id;
      ctx.bindTurn?.(turnId);
      ctx.bindSteer?.(async (text, images) => {
        if (ctx.signal.aborted || !turnId || rpc.closed) return false;
        await rpc.request(
          'turn/steer',
          {
            threadId,
            expectedTurnId: turnId,
            input: [
              { type: 'text', text_elements: [], text },
              ...(images || []).map((i) => ({ type: 'image', url: i.dataUrl })),
            ],
          },
          10000
        );
        return true;
      });
      ctx.signal.throwIfAborted();
      return (ctx.result?.parse || parseNotes)(await completed);
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      throw ctx.signal.aborted ? ctx.signal.reason : agentError(error, 'codex');
    } finally {
      ctx.bindSteer?.(null);
      ctx.signal.removeEventListener('abort', abort);
      await rpc.close();
    }
  }
}
