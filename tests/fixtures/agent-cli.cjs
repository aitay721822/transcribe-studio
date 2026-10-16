const readline = require('node:readline');

const args = process.argv.slice(2);

const trace = (value) => {
  if (process.env.STUDIO_FIXTURE_TRACE)
    require('node:fs').appendFileSync(
      process.env.STUDIO_FIXTURE_TRACE,
      `${JSON.stringify(value)}\n`
    );
};

trace({ args });
if (args.includes('--version')) {
  console.log('fixture-cli 1.0');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(
    JSON.stringify({
      loggedIn: process.env.STUDIO_FIXTURE_ACCOUNT !== 'signed-out',
      email: process.env.STUDIO_FIXTURE_ACCOUNT || 'fixture@example.test',
      authMethod: 'oauth_token',
    })
  );
  process.exit(0);
}

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (process.env.STUDIO_FIXTURE_CHILD) {
  const child = require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { windowsHide: true }
  );
  trace({ descendant: child.pid });
}
const lines = readline.createInterface({ input: process.stdin });
if (args[0] === 'app-server') {
  lines.on('line', (line) => {
    const m = JSON.parse(line);
    trace(m);
    if (m.id === undefined) return;

    const rpcResult = () => {
      if (m.method === 'account/read') {
        return {
          account:
            process.env.STUDIO_FIXTURE_ACCOUNT === 'signed-out'
              ? null
              : {
                  type: 'chatgpt',
                  email: process.env.STUDIO_FIXTURE_ACCOUNT || 'fixture@example.test',
                },
          requiresOpenaiAuth: true,
        };
      }
      if (m.method === 'model/list') {
        return {
          data: [{ model: 'fixture-model', displayName: 'Fixture Model', isDefault: true }],
        };
      }
      if (m.method === 'config/read') {
        return { config: { model_provider: 'openai', mcp_servers: { inherited: {} } } };
      }
      if (m.method.startsWith('thread/')) {
        return { thread: { id: 'fixture-thread' } };
      }
      if (m.method === 'turn/start') {
        return { turn: { id: 'fixture-turn' } };
      }
      return {};
    };

    const result = rpcResult();
    write({ id: m.id, result });
    if (m.method === 'turn/start') {
      write({
        method: 'item/completed',
        params: {
          threadId: 'fixture-thread',
          turnId: 'fixture-turn',
          item: { type: 'agentMessage', text: JSON.stringify({ notes: '# fixture Codex' }) },
        },
      });
      write({
        method: 'turn/completed',
        params: {
          threadId: 'fixture-thread',
          turnId: 'fixture-turn',
          turn: { id: 'fixture-turn', status: 'completed' },
        },
      });
    }
  });
} else {
  write({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' });
  lines.on('line', async (line) => {
    const m = JSON.parse(line);
    trace(m);
    write(m);
    if (m.message.content === 'hang') {
      const child = require('node:child_process').spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { windowsHide: true }
      );
      trace({ descendant: child.pid });
      return;
    }
    if (m.message.content === 'invalid') {
      console.log('not JSON');
      return;
    }
    write({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: { notes: '# fixture Claude' },
    });
  });
}
