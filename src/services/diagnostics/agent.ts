import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ClaudeAdapter } from '../../ai/adapters/claude';
import { CodexAdapter } from '../../ai/adapters/codex';
import { OpenAiAdapter } from '../../ai/adapters/openai';
import type { HarnessAdapter, HarnessContext } from '../../ai/contracts';
import type { Meeting, Settings } from '../../domain/models';
import { setupReadiness } from '../../domain/readiness';

export async function testAgent(
  settings: Settings,
  runtimeRoot: string,
  controller: AbortController,
  progress: (message: string) => void,
  adapters: HarnessAdapter[] = [new OpenAiAdapter(), new CodexAdapter(), new ClaudeAdapter()]
) {
  if (!setupReadiness(settings).agent) throw new Error('請先完成 Agent 認證方式、模型與服務設定');
  const adapter = adapters.find((a) => a.id === (settings.llm.backend || 'openai'));
  if (!adapter) throw new Error('Agent 後端無效');
  const id = randomUUID(),
    root = path.resolve(runtimeRoot, 'connection-tests'),
    runtimeDir = path.join(root, id);
  const meeting: Meeting = {
    id,
    projectId: id,
    title: '連線測試',
    source: 'test',
    status: 'draft',
    notes: '',
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    duration: 0,
    segments: [],
    recordings: [],
    markers: [],
    chats: [],
    references: [],
  };
  const ctx: HarnessContext = {
    request: { meetingId: id, instruction: '請僅回覆：連線測試成功。' },
    meeting,
    project: { id, name: '連線測試', roots: [], createdAt: meeting.createdAt },
    settings,
    skills: [],
    runtimeDir,
    controller,
    signal: controller.signal,
    maxSteps: 2,
    ephemeral: true,
    instructions:
      '這是連線測試，不需要工具、檔案或會議資料。請回覆「連線測試成功」。若 schema 要求 notes，將回覆放在 notes。',
    prompt: '請僅回覆：連線測試成功。',
    tools: {
      specs: () => [],

      call: async () => {
        throw new Error('連線測試不提供工具');
      },
    },

    emit: (event) => {
      if (event.message) progress(event.message);
    },

    bindSession: () => {},
  };
  if (path.dirname(runtimeDir) !== root) throw new Error('測試目錄無效');
  try {
    controller.signal.throwIfAborted();
    const reply = await adapter.execute(ctx);
    controller.signal.throwIfAborted();
    if (!reply?.trim()) throw new Error('Agent 未回傳測試文字');
    return { reply: reply.slice(0, 2000), backend: adapter.id };
  } finally {
    await adapter.close?.();
    await fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
