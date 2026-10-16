async function main() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );
  const server = new Server(
    { name: 'studio-test-tools', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'context',
        description: 'Read test context',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => ({
    content: [{ type: 'text', text: `MCP context for ${req.params.arguments.query}` }],
  }));
  await server.connect(new StdioServerTransport());
}

main().catch(() => process.exit(1));
