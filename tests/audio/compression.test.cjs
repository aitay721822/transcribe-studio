const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { AsrSession } = require('../../dist/transport/asr.cjs');
const { DEFAULTS } = require('../../dist/persistence/store.cjs');

for (const provider of ['websocket', 'openai', 'vllm']) {
  for (const disabled of [undefined, false, true]) {
    test(`${provider} negotiates compression with disablePerMessageDeflate=${disabled}`, async () => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
      await new Promise((resolve) => server.once('listening', resolve));
      let offered;
      let negotiated;
      server.on('connection', (socket, request) => {
        offered = request.headers['sec-websocket-extensions'];
        negotiated = socket.extensions;
        socket.on('message', (raw) => {
          const data = JSON.parse(raw.toString());
          if (data.type === 'session.update')
            socket.send(JSON.stringify({ type: 'session.updated' }));
        });
        if (provider === 'vllm') socket.send(JSON.stringify({ type: 'session.created' }));
      });
      const config = {
        ...DEFAULTS.asr,
        provider: provider === 'vllm' ? 'openai' : provider,
        realtimeFlavor: provider === 'vllm' ? 'vllm' : 'openai',
        url: `ws://127.0.0.1:${server.address().port}`,
      };
      if (disabled === undefined) delete config.disablePerMessageDeflate;
      else config.disablePerMessageDeflate = disabled;
      const session = new AsrSession(config, () => {});
      try {
        await session.connect();
        if (disabled === true) {
          assert.equal(offered, undefined);
          assert.equal(negotiated, '');
        } else {
          assert.match(offered, /permessage-deflate/);
          assert.equal(negotiated, 'permessage-deflate');
        }
      } finally {
        await session.close();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
}
