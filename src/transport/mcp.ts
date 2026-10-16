import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolSpec } from '../ai/contracts';
import type { Settings } from '../domain/models';

export interface RemoteTool {
  spec: ToolSpec;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}
export class McpToolConnections {
  private clients: Client[] = [];

  async discover(
    settings: Settings,
    confirm: (name: string, args: unknown) => Promise<boolean>,
    signal: AbortSignal,
    log: (message: string) => void
  ): Promise<RemoteTool[]> {
    const entries: RemoteTool[] = [];
    for (const server of settings.mcp.filter((s) => s.enabled)) {
      if (
        !(await confirm(`連線 MCP：${server.name}`, {
          transport: server.transport,
          command: server.command,
          url: server.url,
        }))
      ) {
        log(`已略過 ${server.name}`);
        continue;
      }
      signal.throwIfAborted();
      const client = new Client({ name: 'transcribe-studio', version: '0.2.0' });
      this.clients.push(client);
      const transport =
        server.transport === 'stdio'
          ? new StdioClientTransport({
              command: server.command,
              args: server.args || [],
              env: server.env,
              stderr: 'pipe',
            })
          : new StreamableHTTPClientTransport(new URL(server.url), {
              requestInit: { headers: server.headers || {} },
            });
      try {
        await client.connect(transport, { signal, timeout: 15000 });
        const { tools } = await client.listTools({}, { signal, timeout: 15000 });
        for (const tool of tools.slice(0, 60)) {
          const name =
            'studio_mcp_' +
            createHash('sha256').update(`${server.name}:${tool.name}`).digest('hex').slice(0, 16);
          entries.push({
            spec: {
              name,
              description: `${server.name} / ${tool.name}: ${tool.description || ''}`,
              inputSchema: tool.inputSchema,
            },

            invoke: async (args) => {
              if (!(await confirm(`${server.name} / ${tool.name}`, args)))
                return { error: '使用者拒絕工具執行' };
              signal.throwIfAborted();
              return client.callTool({ name: tool.name, arguments: args }, undefined, {
                signal,
                timeout: 30000,
              });
            },
          });
        }
        log(`${server.name}：已載入 ${Math.min(60, tools.length)} 個 MCP 工具`);
      } catch (caughtError) {
        const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

        if (signal.aborted) throw error;
        log(`${server.name}：${error.message}`);
      }
    }
    return entries;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
  }
}
