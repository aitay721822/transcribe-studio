const http = require('node:http');
const { WebSocketServer } = require('ws');

async function transcriptionServer() {
  const uploads = [],
    realtime = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      const form = await new Request('http://localhost', {
        method: 'POST',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }).formData();
      const file = form.get('file'),
        bytes = Buffer.from(await file.arrayBuffer());
      uploads.push({
        path: req.url,
        auth: req.headers.authorization,
        name: file.name,
        type: file.type,
        model: form.get('model'),
        language: form.get('language'),
        bytes,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: `HTTP 辨識段落 ${uploads.length}` }));
    } catch (e) {
      res.writeHead(400);
      res.end(e.message);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocketServer({ server });
  ws.on('connection', (socket, req) => {
    const events = [],
      route = { path: req.url, auth: req.headers.authorization, events };
    realtime.push(route);
    let partial = false;
    socket.send(JSON.stringify({ type: 'session.created' }));
    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.type === 'input_audio_buffer.append' && !partial) {
        partial = true;
        socket.send(JSON.stringify({ type: 'transcription.delta', delta: 'vLLM 即時文字' }));
      }
      if (event.final)
        socket.send(JSON.stringify({ type: 'transcription.done', text: 'vLLM 即時文字完成' }));
    });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    uploads,
    realtime,
    offline: `${origin}/v1/audio/transcriptions?route=file`,
    live: `${origin.replace('http:', 'ws:')}/v1/realtime`,

    async close() {
      for (const socket of ws.clients) socket.terminate();
      await new Promise((r) => ws.close(r));
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { transcriptionServer };
