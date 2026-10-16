const { test } = require('node:test');
const assert = require('node:assert/strict');
const { meetingGateway } = require('../../dist/transport/claude/gateway.cjs');

test('meeting gateway authenticates each request, exposes only run tools and rejects calls after abort', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const controller = new AbortController(),
    calls = [];
  const gateway = await meetingGateway(
    {
      specs: () => [
        { name: 'studio_read_notes', description: 'read', inputSchema: { type: 'object' } },
      ],

      call: async (name, args) => {
        calls.push({ name, args });
        return { notes: 'original' };
      },
    },
    controller.signal
  );
  const config = gateway.config.mcpServers.meeting;
  const client = new Client({ name: 'test', version: '1' });
  try {
    assert.equal((await fetch(config.url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal(
      (
        await fetch(config.url, {
          method: 'POST',
          headers: { ...config.headers, Origin: 'https://untrusted.test' },
          body: '{}',
        })
      ).status,
      403
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      })
    );
    assert.equal((await client.listTools()).tools.length, 1);
    const result = await client.callTool({
      name: 'meeting_tool',
      arguments: { name: 'studio_read_notes', args: {} },
    });
    assert.match(result.content[0].text, /original/);
    await assert.rejects(
      client.callTool({ name: 'meeting_tool', arguments: { name: 'Bash', args: {} } })
    );
    assert.equal(calls.length, 1);
    controller.abort();
    await assert.rejects(
      client.callTool({ name: 'meeting_tool', arguments: { name: 'studio_read_notes', args: {} } })
    );
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    await gateway.close();
  }
  await assert.rejects(fetch(config.url));
});
