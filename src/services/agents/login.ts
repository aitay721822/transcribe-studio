import { createHash } from 'node:crypto';
import os from 'node:os';
import { CodexRpcClient } from '../../transport/codex-rpc';
import { spawnHidden } from '../../transport/runtime/launch';
import { stopChild } from '../../transport/runtime/process';
import { codexArgs } from './config';
import { launchCommand } from './executable';

export interface LoginState {
  status: 'signed-in' | 'signed-out' | 'unknown';
  detail: string;
  identity?: string;
  models?: { id: string; name: string; isDefault: boolean }[];
}

export async function captureCli(file: string, args: string[], timeout = 5000) {
  const command = await launchCommand(file);
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawnHidden(command.executable, [...command.args, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: os.tmpdir(),
    });
    child.stdin.end();
    let output = '';
    let settled = false;

    const finish = async (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        await stopChild(child);
        reject(error);
      } else resolve({ code, output });
    };

    const timer = setTimeout(() => void finish(new Error('CLI 狀態偵測逾時')), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`;
      if (output.length > 1048576) {
        void finish(new Error('CLI 輸出過大'));
      }
    });
    child.stderr.resume();
    child.once('error', (error) => void finish(error));
    child.once('close', (code) => void finish(undefined, code));
  });
}

const identity = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function probeLogin(id: 'codex' | 'claude', file: string): Promise<LoginState> {
  if (id === 'claude') {
    try {
      const result = await captureCli(file, ['auth', 'status', '--json']);
      const account = JSON.parse(result.output);
      if (typeof account.loggedIn !== 'boolean') throw new Error('不支援的登入狀態格式');
      return {
        status: account.loggedIn ? 'signed-in' : 'signed-out',
        detail: account.loggedIn ? 'CLI 已登入' : '尚未登入，請執行 claude auth login',
        identity: identity([account.authMethod, account.email, account.orgId, account.loggedIn]),
      };
    } catch {
      return { status: 'unknown', detail: '無法確認 CLI 登入，請執行連線測試' };
    }
  }
  const rpc = new CodexRpcClient(file, codexArgs, os.tmpdir(), {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  });
  try {
    await rpc.start();
    const account = await rpc.request<import('../../transport/runtime/codex-types').CodexAccount>(
      'account/read',
      { refreshToken: false },
      5000
    );
    const models: LoginState['models'] = [];
    if (account.account || !account.requiresOpenaiAuth) {
      try {
        let cursor: string | undefined;
        do {
          const list = await rpc.request<{
            data: { id: string; model: string; displayName: string; isDefault?: boolean }[];
            nextCursor?: string;
          }>('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, 5000);
          models.push(
            ...list.data.map((m) => ({
              id: m.model || m.id,
              name: m.displayName || m.model || m.id,
              isDefault: !!m.isDefault,
            }))
          );
          cursor = list.nextCursor;
        } while (cursor && models.length < 300);
      } catch {
        /* A catalog failure doesn't invalidate authentication. */
      }
    }

    const accountDetail = () => {
      if (account.account) {
        return 'CLI 已登入';
      }
      if (account.requiresOpenaiAuth) {
        return '尚未登入，請執行 codex login';
      }
      return 'CLI 使用自訂服務，請執行連線測試';
    };

    const accountStatus = () => {
      if (account.account) {
        return 'signed-in';
      }
      if (account.requiresOpenaiAuth) {
        return 'signed-out';
      }
      return 'unknown';
    };

    return {
      status: accountStatus(),
      detail: accountDetail(),
      identity: identity(account.account),
      models,
    };
  } catch {
    return { status: 'unknown', detail: '無法確認 CLI 登入，請執行連線測試' };
  } finally {
    await rpc.close();
  }
}
