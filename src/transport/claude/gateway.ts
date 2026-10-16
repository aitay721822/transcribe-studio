import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolPort } from '../../ai/contracts';

/** Per-run loopback gateway, backed only by this run's ToolPort. */
export async function meetingGateway(tools: ToolPort, signal: AbortSignal) {
  const token = randomBytes(32).toString('hex');
  const active = new Set<Server>();
  const http = createServer(async (req, res) => {
    if (
      req.url !== '/mcp' ||
      req.headers.authorization !== `Bearer ${token}` ||
      req.headers.origin
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST' || signal.aborted) {
      res.writeHead(signal.aborted ? 410 : 405).end();
      return;
    }
    const server = new Server(
      { name: 'meeting', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.specs().length
        ? [
            {
              name: 'meeting_tool',
              description: '執行會議工具。name 與 args 請依 system prompt 的工具清單 JSON Schema。',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' }, args: { type: 'object' } },
                required: ['name', 'args'],
                additionalProperties: false,
              },
            },
          ]
        : [],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      signal.throwIfAborted();
      const args = params.arguments;
      if (
        params.name !== 'meeting_tool' ||
        typeof args?.name !== 'string' ||
        !tools.specs().some((spec) => spec.name === args.name)
      )
        throw new Error('會議工具無效');
      try {
        const result = await tools.call(args.name, args.args);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
      } catch (caughtError) {
        const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

        return { isError: true, content: [{ type: 'text', text: String(error.message) }] };
      }
    });
    active.add(server);
    res.on('close', () => {
      active.delete(server);
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  http.requestTimeout = 300000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address() as { port: number };
  return {
    config: {
      mcpServers: {
        meeting: {
          type: 'http',
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },

    async close() {
      await Promise.allSettled([...active].map((server) => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
