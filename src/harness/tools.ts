import Ajv from 'ajv';
import type { ToolSpec } from '../ai/contracts';
import type { Meeting, Project, Settings, Skill } from '../domain/models';
import type { WorkspaceArgs } from '../domain/workspace';
import { MeetingHistoryReader, type MeetingHistoryStore } from '../services/meetings/history';
import * as workspace from '../services/workspace/files';
import { McpToolConnections } from '../transport/mcp';

interface ToolArguments extends WorkspaceArgs, Record<string, unknown> {
  meetingId?: string;
  id?: string;
}

const ajv = new Ajv({ strict: false });
type Handler = (args: ToolArguments, progress?: (value: unknown) => void) => Promise<unknown>;
interface Entry {
  spec: ToolSpec;
  validate: ReturnType<typeof ajv.compile>;
  invoke: Handler;
}
export class MeetingToolRegistry {
  private entries = new Map<string, Entry>();
  private mcp = new McpToolConnections();
  private cursors = new Set<string>();

  constructor(
    private meeting: Meeting,
    private project: Project,
    private skills: Skill[],
    private confirm: (name: string, args: unknown) => Promise<boolean>,
    private signal: AbortSignal,
    historyStore?: MeetingHistoryStore
  ) {
    if (historyStore) {
      const history = new MeetingHistoryReader(historyStore, meeting);
      this.add(
        'studio_search_meetings',
        '列出或搜尋同專案先前的會議紀錄，排除本次會議；回傳 meetingId、版本、摘要與引用標記，可用 studio_read_meeting 讀取原文。',
        {
          query: { type: 'string', maxLength: 200 },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        [],
        async (a) => history.search(a.query, a.offset, a.limit)
      );
      this.add(
        'studio_read_meeting',
        '分頁讀取同專案先前會議的紀錄原文，offset/limit 單位為字元；引用回傳的 citation，並區分歷史背景與本次決議。',
        {
          meetingId: { type: 'string', minLength: 1 },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 16000 },
        },
        ['meetingId'],
        async (a) => history.read(a.meetingId, a.offset, a.limit)
      );
    }
    this.add(
      'studio_list_files',
      '分頁列出已授權的參考檔案，沒有檔案總數或目錄深度上限。query 篩選檔名／路徑；可用 rootId + directory（相對路徑，空字串為根目錄）限定子資料夾並遞迴搜尋。沿用 nextCursor 續掃，需保持相同 rootId/directory/query；null 代表完成，空頁仍可能有下一頁。',
      {
        query: { type: 'string', maxLength: 200 },
        cursor: { type: 'string', maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        rootId: { type: 'string', maxLength: 300 },
        directory: { type: 'string', maxLength: 2000 },
      },
      [],
      async (a, progress) =>
        this.page(a, () =>
          workspace.listFiles(project.roots, a.query || '', { ...a, signal, onProgress: progress })
        )
    );
    this.add(
      'studio_search_files',
      '類似 grep：串流搜尋已授權資料夾內的完整文字，不受畫面清單限制。query 是單行字面文字，非正規表示式。可用 rootId + directory 限定子資料夾並遞迴搜尋。每個符合行回傳一筆有界摘要、line、offset、version 與引用；可帶入 studio_read_file 深讀。沿用 nextCursor 續掃（需相同查詢與範圍），空頁仍可能有下一頁，null 才表示掃描完成。stats/errors 揭露已掃描量與略過錯誤。',
      {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        cursor: { type: 'string', maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        pathQuery: { type: 'string', maxLength: 200 },
        caseSensitive: { type: 'boolean' },
        rootId: { type: 'string', maxLength: 300 },
        directory: { type: 'string', maxLength: 2000 },
      },
      ['query'],
      async (a, progress) =>
        this.page(a, () =>
          workspace.searchFiles(project.roots, a.query, { ...a, signal, onProgress: progress })
        )
    );
    this.add(
      'studio_read_file',
      '類似 cat 的分段讀取：offset/limit 為位元組，UTF-8/UTF-16 LE 自動對齊字元；DOCX 使用字元，依 unit 欄位為準。預設 16000、最多 64000。沿用 nextOffset 與 version 讀到 null，禁止自行估計下一頁。大文字檔不整份載入，來源有變動會要求重讀。僅可讀已授權資料夾。',
      {
        rootId: { type: 'string' },
        relative: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 4, maximum: 64000 },
        version: { type: 'string', maxLength: 300 },
      },
      ['rootId', 'relative'],
      async (a) => workspace.readFilePage(project.roots, a.rootId, a.relative, { ...a, signal })
    );
    this.add(
      'studio_cancel_file_scan',
      '放棄本輪不再需要的檔案清單／搜尋游標，釋放背景檔案資源。',
      { cursor: { type: 'string', maxLength: 100 } },
      ['cursor'],
      async (a) => {
        if (!this.cursors.delete(a.cursor)) throw new Error('游標不屬於本次工作');
        workspace.releaseCursor(a.cursor);
        return { cancelled: true };
      }
    );
    this.add(
      'studio_read_transcript',
      '分頁讀取或搜尋本次會議逐字稿，每頁最多 60 個片段。下一頁的 offset 必須使用上次回傳的 nextOffset；nextOffset 為 null 時已讀完，不要反覆用相同參數讀取同一頁。',
      {
        query: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 60 },
      },
      [],
      async (a) => {
        const segments = meeting.segments.filter(
          (s) => s.final && (!a.query || s.text.toLowerCase().includes(a.query.toLowerCase()))
        );
        const offset = a.offset || 0;
        const limit = a.limit || 40;
        return {
          total: segments.length,
          offset,
          limit,
          segments: segments.slice(offset, offset + limit),
          nextOffset: offset + limit < segments.length ? offset + limit : null,
        };
      }
    );
    this.add(
      'studio_read_notes',
      '取得本次修訂的會議紀錄快照與版本，不會改動文件。',
      {},
      [],
      async () => ({ title: meeting.title, notes: meeting.notes, version: meeting.version })
    );
    this.add(
      'studio_load_skill',
      '依技能清單的 id 載入 SKILL.md，按需讀取完整技能說明。',
      { id: { type: 'string' } },
      ['id'],
      async (a) => {
        const skill = skills.find((s) => s.id === a.id);
        if (!skill) throw new Error('技能未授權');
        return skill.content;
      }
    );
  }

  private add(
    name: string,
    description: string,
    properties: object,
    required: string[],
    invoke: Handler
  ): void {
    const schema = { type: 'object', properties, required, additionalProperties: false };
    this.entries.set(name, {
      spec: { name, description, inputSchema: schema },
      validate: ajv.compile(schema),
      invoke,
    });
  }

  async connectMcp(settings: Settings, log: (message: string) => void): Promise<void> {
    for (const entry of await this.mcp.discover(settings, this.confirm, this.signal, log)) {
      try {
        this.entries.set(entry.spec.name, {
          ...entry,
          validate: ajv.compile(entry.spec.inputSchema),
        });
      } catch {
        log(`MCP 工具 ${entry.spec.name} 的 JSON Schema 無效，已略過`);
      }
    }
  }

  specs(): ToolSpec[] {
    return [...this.entries.values()].map((e) => e.spec);
  }

  private async page<T extends { nextCursor?: string }>(
    args: ToolArguments,
    run: () => Promise<T>
  ) {
    if (args.cursor && !this.cursors.has(args.cursor))
      throw new Error('游標不屬於本輪工作，請重新搜尋');
    const result = await run();
    if (args.cursor) this.cursors.delete(args.cursor);
    if (result.nextCursor) this.cursors.add(result.nextCursor);
    return result;
  }

  async call(name: string, args: unknown, progress?: (value: unknown) => void): Promise<unknown> {
    this.signal.throwIfAborted();
    const entry = this.entries.get(name);
    if (!entry || !entry.validate(args)) throw new Error('工具不存在或參數不符 JSON Schema');
    const value = await entry.invoke(args as ToolArguments, progress);
    const text = JSON.stringify(value ?? null);
    return text.length > 80000 &&
      !['studio_read_file', 'studio_list_files', 'studio_search_files'].includes(name)
      ? { truncated: true, content: text.slice(0, 80000) }
      : value;
  }

  async close(): Promise<void> {
    for (const token of this.cursors) workspace.releaseCursor(token);
    this.cursors.clear();
    await this.mcp.close();
  }
}
