import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessAdapter } from '../../../ai/contracts';
import type { AgentEntities, AgentEvent, AgentStore } from '../../../domain/models';
import { Agent } from '../../../harness/coordinator';
import { ConversationRepository } from '../../../persistence/conversations';
import type { ImageVault } from './images';

interface TemporarySession {
  id: string;
  meetingId: string;
  store: AgentStore & { conversations: ConversationRepository };
  directory: string;
  active: boolean;
  agent: Agent;
}

export class TemporaryAgents {
  private sessions = new Map<string, TemporarySession>();

  constructor(
    private base: Pick<AgentStore, 'get' | 'meetings' | 'settings'>,
    private bundled: string,
    private runtime: string,
    private emit: (event: AgentEvent) => void,
    private images: ImageVault,
    private adapters?: HarnessAdapter[]
  ) {}

  begin(meetingId: string) {
    if (!this.base.get('meetings', meetingId)) throw new Error('找不到會議');
    if (this.sessions.size) throw new Error('請先離開目前的暫時對話');
    const id = randomUUID(),
      journal = new ConversationRepository('', true);
    let annotations = this.base.get('meetings', meetingId).annotations || [];
    const store: AgentStore & { conversations: ConversationRepository } = {
      get: <T extends keyof AgentEntities>(table: T, key: string): AgentEntities[T] => {
        const source = this.base.get(table, key);
        if (!source || table !== 'meetings' || key !== meetingId) return source;
        return {
          ...source,
          annotations,
          chats: journal.messages(key),
          agentSessions: journal.sessions(key),
          contextMemory: journal.memory(key),
          agentHistory: journal.runs(key).map((r) => ({
            runId: r.id,
            notes: r.notes,
            answer: r.events?.find((event) => event.type === 'answer')?.message,
            messageId: r.input?.messageId,
            started: r.events?.some((event) => event.type === 'started'),
            status: r.status,
            version: r.version,
            createdAt: r.startedAt,
          })),
        } as AgentEntities[T];
      },

      meetings: () => this.base.meetings(),

      settings: () => this.base.settings(),

      conversations: journal,

      queuedRuns: () => [],

      saveRun: (run) => journal.saveRun(run),

      updateMeeting: (key, patch) => {
        if (patch.annotations) annotations = patch.annotations;
        if (patch.agentSessions)
          for (const [backend, binding] of Object.entries(patch.agentSessions))
            journal.append(key, 'session', { backend, binding });
        return store.get('meetings', key);
      },
    };
    const directory = path.join(this.runtime, id);
    const session: TemporarySession = {
      id,
      meetingId,
      store,
      directory,
      active: true,
      agent: undefined,
    };
    session.agent = new Agent(
      store,
      this.bundled,
      (event) => {
        if (session.active) this.emit({ ...event, sessionId: id });
      },
      directory,
      this.adapters,
      this.images
    );
    this.sessions.set(id, session);
    return { id, meetingId };
  }

  get(id: string, meetingId?: string) {
    const session = this.sessions.get(id);
    if (!session || (meetingId && session.meetingId !== meetingId))
      throw new Error('暫時對話已結束');
    return session;
  }

  values() {
    return [...this.sessions.values()];
  }

  async end(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.active = false;
    await session.agent.close();
    this.images.clearSession(id);
    const directory = path.resolve(this.runtime, id);
    if (path.dirname(directory) !== path.resolve(this.runtime)) throw new Error('暫時目錄無效');
    await fs.rm(directory, { recursive: true, force: true });
  }

  async close() {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.end(id)));
  }
}
