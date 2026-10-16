import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../ai/adapters/claude';
import { CodexAdapter } from '../ai/adapters/codex';
import { OpenAiAdapter } from '../ai/adapters/openai';
import type { BackendId, HarnessAdapter, HarnessContext } from '../ai/contracts';
import { compressionSettings } from '../domain/agents/compression';
import { activeMessages } from '../domain/agents/conversation';
import { executionLimits } from '../domain/agents/limits';
import type { AgentEvent, AgentRequest, AgentRun, AgentStore, ImageData } from '../domain/models';
import { setupReadiness } from '../domain/readiness';
import { contextReferences } from '../domain/references/context';
import { validateReferences } from '../services/workspace/references/resolve';
import { ApprovalQueue } from './approvals';
import { compactConversation } from './context/compact';
import { InputScheduler } from './input/scheduler';
import { instructions, makePrompt } from './prompt';
import { annotationRevision } from './revisions/annotations';
import { answerResult, readInstructions } from './revisions/mode';
import { discoverSkills } from './skills';
import { MeetingToolRegistry } from './tools';

export class Agent {
  readonly runs = new Map<string, AbortController>();
  private inputs: InputScheduler;
  private adapters: Map<BackendId, HarnessAdapter>;
  private approvals: ApprovalQueue;

  constructor(
    private store: AgentStore,
    private bundled: string,
    private emit: (event: AgentEvent) => void,
    private runtimeDir = path.join(os.tmpdir(), 'transcribe-runtime'),
    adapters?: HarnessAdapter[],
    private resources?: { load(request: AgentRequest): Promise<ImageData[]> }
  ) {
    const implementations: HarnessAdapter[] = adapters || [
      new OpenAiAdapter(),
      new CodexAdapter(),
      new ClaudeAdapter(),
    ];
    this.adapters = new Map(implementations.map((a) => [a.id, a] as const));
    this.approvals = new ApprovalQueue(emit);
    this.inputs = new InputScheduler(
      store,
      emit,
      (request, run) => this.execute(request, run),
      (id) => this.runs.get(id)?.abort(new Error('Agent 已停止'))
    );
  }

  approve(id: string, accepted: boolean): void {
    this.approvals.answer(id, accepted);
  }

  cancel(id: string): void {
    this.inputs.cancel(id);
  }

  promote(id: string, expectedRunId: string) {
    return this.inputs.promote(id, expectedRunId);
  }

  isRunningMeeting(id: string): boolean {
    return this.inputs.busy(id);
  }

  async run(request: AgentRequest): Promise<AgentRun> {
    try {
      this.validate(request);
      if (request.references) await this.resolveReferences(request);
      return this.inputs.enqueue(request).promise;
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      return Promise.reject(error);
    }
  }

  async submit(request: AgentRequest, mode: 'queue' | 'steer' = 'queue', expectedRunId?: string) {
    this.validate(request);
    if (request.references) await this.resolveReferences(request);
    return this.inputs.submit(request, mode, expectedRunId);
  }

  inputState(meetingId: string) {
    return this.inputs.state(meetingId);
  }

  resume(meetingId: string) {
    if (!this.store.get('meetings', meetingId)) throw new Error('找不到會議');
    return this.inputs.resume(meetingId);
  }

  private validate(request: AgentRequest) {
    if (
      !request ||
      typeof request.instruction !== 'string' ||
      !request.instruction.trim() ||
      request.instruction.length > 16000 ||
      (request.selection?.length || 0) > 80000 ||
      (request.selection != null && typeof request.selection !== 'string') ||
      (request.skillIds != null &&
        (!Array.isArray(request.skillIds) ||
          request.skillIds.length > 20 ||
          request.skillIds.some((id) => typeof id !== 'string' || id.length > 300)))
    )
      throw new Error('修訂要求為空白或內容過長');
    const meeting = this.store.get('meetings', request.meetingId);
    if (!meeting) throw new Error('找不到會議');
    if (request.mode != null && !['edit', 'read'].includes(request.mode))
      throw new Error('無效的權限模式');
    if (request.mode === 'read' && request.annotationIds?.length)
      throw new Error('唯讀模式不能送出編修標記');
    if (
      request.images != null &&
      (!Array.isArray(request.images) ||
        request.images.length > 8 ||
        request.images.some(
          (image) => !image || typeof image.id !== 'string' || !/^[0-9a-f-]{36}$/.test(image.id)
        ))
    )
      throw new Error('圖片附件無效或超過 8 張');
    if (request.images?.length && !this.resources) throw new Error('圖片儲存服務未啟用');
    request.references = contextReferences(
      request.references,
      this.store.get('projects', meeting.projectId)?.roots || []
    );
    if (request.annotationIds != null) annotationRevision(request, meeting);
  }

  private async resolveReferences(request: AgentRequest) {
    const meeting = this.store.get('meetings', request.meetingId);
    request.references = await validateReferences(
      this.store.get('projects', meeting.projectId)?.roots || [],
      request.references
    );
  }

  private async execute(request: AgentRequest, run: AgentRun): Promise<AgentRun> {
    let meeting = this.store.get('meetings', request.meetingId);
    if (!meeting) throw new Error('找不到會議');
    const revision = annotationRevision(request, meeting);
    const project = this.store.get('projects', meeting.projectId);
    if (!project) throw new Error('找不到專案');
    if (request.references) await this.resolveReferences(request);
    const settings = this.store.settings();
    const backend =
      settings.llm.backend === 'responses' ? 'openai' : settings.llm.backend || 'openai';
    const adapter = this.adapters.get(backend);
    if (!adapter) throw new Error('尚未支援此 harness');
    if (!setupReadiness(settings).agent) throw new Error('請先完成 Agent 認證方式、模型與服務設定');
    if (
      !request.instruction?.trim() ||
      request.instruction.length > 16000 ||
      (request.selection?.length || 0) > 80000
    )
      throw new Error('修訂要求為空白或內容過長');
    if (!request.command && meeting.notes.length > 80000)
      throw new Error('紀錄過長，請先拆成較小的文件再修訂');
    const controller = new AbortController();
    const limits = executionLimits(settings.llm);
    const signal = controller.signal;
    Object.assign(run, { version: meeting.version, status: 'running', backend });
    this.runs.set(run.id, controller);

    const send = (event: AgentEvent) => {
      event = { id: randomUUID(), timestamp: new Date().toISOString(), ...event };
      run.events.push(event);
      this.store.saveRun(run);
      this.emit({ ...event, runId: run.id, meetingId: meeting.id });
    };

    send({ type: 'started', version: meeting.version, args: { limits, backend } });
    send({
      type: 'request',
      args: {
        instruction: request.instruction,
        selection: request.selection || '',
        skillIds: request.skillIds || [],
        annotationIds: request.annotationIds || [],
        references: request.references ?? meeting.references,
        images: request.images,
        mode: request.mode || 'edit',
        markedRevisions: revision?.targets,
      },
    });
    const timeout =
      limits.timeoutMinutes > 0
        ? setTimeout(
            () => controller.abort(new Error(`已達到 ${limits.timeoutMinutes} 分鐘執行上限`)),
            limits.timeoutMinutes * 60000
          )
        : undefined;
    let registry: MeetingToolRegistry;
    try {
      const skills = request.command ? [] : await discoverSkills(project.roots, this.bundled);
      registry = new MeetingToolRegistry(
        meeting,
        project,
        skills,
        (name, args) => this.approvals.confirm(run, name, args, signal, send),
        signal,
        this.store
      );
      if (!request.command && request.mode !== 'read' && !request.sessionId)
        await registry.connectMcp(settings, (message) => send({ type: 'log', message }));
      signal.throwIfAborted();
      let calls = 0;
      const maxSteps = limits.maxSteps;
      const context: HarnessContext = {
        request,
        meeting,
        project,
        settings,
        skills,
        instructions: revision
          ? instructions +
            '\n本次是標記修訂，最終必須依 markedRevisions 與 revisionOutput 回傳 replacements JSON，覆蓋完整紀錄的輸出規則。'
          : `${instructions}${request.mode === 'read' ? `\n${readInstructions}` : ''}`,
        result: request.mode === 'read' ? answerResult : revision,
        ephemeral: request.sessionId ? true : undefined,
        images: request.command
          ? []
          : await this.resources?.load({
              ...request,
              images: request.images?.length
                ? request.images
                : activeMessages(request, meeting)
                    .slice(-3)
                    .reverse()
                    .find((chat) => chat.images?.length)?.images || [],
            }),
        runtimeDir: this.runtimeDir,
        prompt: makePrompt(request, meeting, skills, project.roots),
        signal,
        controller,
        maxSteps,
        emit: send,
        tools: {
          specs: () => registry.specs(),

          call: async (name, args) => {
            signal.throwIfAborted();
            if (++calls > limits.maxToolCalls && limits.maxToolCalls > 0) {
              controller.abort(new Error(`已達到工具呼叫上限（${limits.maxToolCalls} 次）`));
              signal.throwIfAborted();
            }
            const callId = randomUUID();
            const started = Date.now();
            send({ type: 'tool', name, args, callId, status: 'running' });
            try {
              const result = await registry.call(name, args, (progress) =>
                send({ type: 'tool-progress', name, callId, args: progress })
              );
              send({
                type: 'tool-result',
                name,
                result,
                callId,
                status: 'completed',
                durationMs: Date.now() - started,
              });
              return result;
            } catch (caughtError) {
              const error =
                caughtError instanceof Error ? caughtError : new Error(String(caughtError));

              const result = { error: error.message };
              send({
                type: 'tool-result',
                name,
                result,
                callId,
                status: signal.aborted ? 'cancelled' : 'error',
                durationMs: Date.now() - started,
              });
              if (signal.aborted) throw error;
              return result;
            }
          },
        },

        bindSession: (binding) => {
          run.threadId = binding.id;
          this.store.updateMeeting?.(meeting.id, {
            agentSessions: { ...meeting.agentSessions, [backend]: binding },
          });
          send({ type: 'session', id: binding.id, message: backend });
        },

        bindSteer: (handler) =>
          this.inputs.bindSteer(
            run.id,
            handler
              ? async (text, steering) =>
                  handler(text, steering ? await this.resources?.load(steering) : [])
              : null
          ),

        bindTurn: (id) => {
          run.turnId = id;
          this.store.saveRun(run);
        },
      };
      const compact = compressionSettings(settings.llm);
      const contextSize = this.store.conversations
        ? JSON.stringify(this.store.conversations.context(meeting.id)).length
        : 0;
      if (
        request.command === 'compact' ||
        (compact.autoCompact && contextSize >= compact.compactThreshold)
      ) {
        let usedRequests = 0;
        try {
          await compactConversation(
            context,
            {
              id: adapter.id,

              execute: (summaryContext) => {
                usedRequests++;
                return adapter.execute(summaryContext);
              },
            },
            this.store,
            request.command === 'compact' ? maxSteps : maxSteps - 1
          );
          if (request.command === 'compact') {
            run.status = 'proposed';
            send({ type: 'context-completed', message: '對話上下文已整理' });
            return run;
          }
          meeting = this.store.get('meetings', meeting.id);
          context.meeting = meeting;
          context.prompt = makePrompt(request, meeting, skills, project.roots);
        } catch (caughtError) {
          const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

          if (signal.aborted || request.command === 'compact') throw error;
          send({ type: 'log', message: `自動壓縮略過：${error.message}` });
        } finally {
          context.maxSteps -= usedRequests;
        }
      }
      const notes = await adapter.execute(context);
      signal.throwIfAborted();
      if ((!revision && !notes.trim()) || notes.length > 1000000)
        throw new Error('Agent 提案為空白或過大');
      run.status = 'proposed';
      if (request.mode === 'read') {
        send({ type: 'answer', message: notes });
        return run;
      }
      run.notes = notes;
      send({
        type: 'proposal',
        notes,
        version: meeting.version,
        annotationIds: request.annotationIds,
        annotationScope: revision?.targets,
      });
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

      run.status = signal.aborted ? 'cancelled' : 'failed';
      send({
        type: 'error',
        message: signal.aborted ? signal.reason?.message || 'Agent 已停止' : error.message,
      });
    } finally {
      this.inputs.bindSteer(run.id, null);
      clearTimeout(timeout);
      this.runs.delete(run.id);
      await registry?.close();
      this.store.saveRun(run);
    }
    return run;
  }

  async close(): Promise<void> {
    await this.inputs.close();
    await Promise.allSettled([...this.adapters.values()].map((a) => a.close?.()));
  }
}
