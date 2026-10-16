const http = require('node:http');

const createMock = ({ beforeMessage } = {}) => {
  let count = 0;
  let meetingRequests = 0;
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw = `${raw}${c}`;
    if (!req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"input_tokens":100}');
      return;
    }
    count++;
    bodies.push(data);
    const meetingRequest = data.tools?.some((t) => t.name === 'mcp__meeting__meeting_tool');
    if (meetingRequest) meetingRequests++;
    await beforeMessage?.(data);

    const responseContent = () => {
      if (meetingRequest && meetingRequests === 1) {
        return [
          {
            type: 'tool_use',
            id: 'tool1',
            name: 'mcp__meeting__meeting_tool',
            input: { name: 'studio_read_notes', args: {} },
          },
        ];
      }
      if (meetingRequest && data.tools.some((t) => t.name === 'StructuredOutput')) {
        return [
          {
            type: 'tool_use',
            id: 'structured1',
            name: 'StructuredOutput',
            input: { notes: '# Claude 本機測試\n完成紀錄' },
          },
        ];
      }
      return [{ type: 'text', text: JSON.stringify({ notes: '# Claude 本機測試\n完成紀錄' }) }];
    };

    const content = responseContent();
    const stop = content[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
    const message = {
      id: `msg_${count}`,
      type: 'message',
      role: 'assistant',
      model: data.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    if (!data.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    const event = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    for (const [index, block] of content.entries()) {
      event('content_block_start', {
        index,
        content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
      });
      event('content_block_delta', {
        index,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text: block.text }
            : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      event('content_block_stop', { index });
    }
    event('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    event('message_stop', {});
    res.end();
  });
  return {
    server,
    bodies,

    get requests() {
      return count;
    },
  };
};

module.exports = { createMock };
