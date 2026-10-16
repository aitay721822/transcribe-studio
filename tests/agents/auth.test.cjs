const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS } = require('../../dist/persistence/store.cjs');
const { agentAuth, agentModel } = require('../../dist/domain/agents/auth.cjs');
const { setupReadiness } = require('../../dist/domain/readiness.cjs');
const { agentHome, agentEnv } = require('../../dist/services/agents/config.cjs');
const { probeLogin } = require('../../dist/services/agents/login.cjs');
const { CodexAdapter } = require('../../dist/ai/adapters/codex.cjs');
const { ClaudeAdapter } = require('../../dist/ai/adapters/claude.cjs');
const { ClaudeProcess } = require('../../dist/transport/claude/process.cjs');
const { CodexRpcClient } = require('../../dist/transport/codex-rpc.cjs');
const { testAgent } = require('../../dist/services/diagnostics/agent.cjs');

const fixture = path.resolve(__dirname, '../fixtures/agent-cli.cjs');

async function environment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function context(backend) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-auth-'));
  const settings = structuredClone(DEFAULTS);
  Object.assign(settings.llm, {
    backend,
    codexAuth: 'cli',
    claudeAuth: 'cli',
    codexPath: fixture,
    claudePath: fixture,
    model: 'api-model-must-not-leak',
  });
  const controller = new AbortController();
  return {
    runtimeDir,
    settings,
    controller,
    signal: controller.signal,
    project: { id: 'project', roots: [] },
    meeting: {},
    prompt: 'revise',
    instructions: 'meeting instructions',
    maxSteps: 5,
    tools: {
      specs: () => [],

      call: async () => {
        throw new Error('unexpected tool');
      },
    },

    emit: () => {},

    bindSession(binding) {
      this.meeting.agentSessions = { [backend]: binding };
    },
  };
}

test('CLI defaults and legacy API settings have distinct readiness and model selection', () => {
  const s = structuredClone(DEFAULTS);
  for (const backend of ['codex', 'claude']) {
    s.llm.backend = backend;
    assert.equal(agentAuth(s.llm), 'cli');
    assert.equal(setupReadiness(s).agent, true);
    s.llm[backend === 'codex' ? 'apiKey' : 'claudeKey'] = 'legacy';
    assert.equal(agentAuth(s.llm), 'api');
    assert.equal(setupReadiness(s).agent, false);
    s.llm[`${backend}Auth`] = 'cli';
    assert.equal(setupReadiness(s).agent, true);
  }
  s.llm.backend = 'codex';
  s.llm.model = 'api-model';
  assert.equal(agentModel(s.llm), '');
  s.llm.codexModel = 'cli-model';
  assert.equal(agentModel(s.llm), 'cli-model');
  s.llm.codexAuth = 'api';
  assert.equal(agentModel(s.llm), 'api-model');
});

test('CLI environment preserves custom home and login, API mode is scoped and explicit', async () => {
  await environment(
    {
      CODEX_HOME: path.join(os.tmpdir(), 'existing-codex'),
      CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'existing-claude'),
      CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth',
      ANTHROPIC_API_KEY: 'inherited-key',
    },
    async () => {
      const llm = {
        codexAuth: 'cli',
        claudeAuth: 'cli',
        apiKey: 'studio-key',
        claudeKey: 'studio-claude-key',
      };
      for (const id of ['codex', 'claude']) {
        const home = agentHome(llm, id, 'runtime', 'project');
        assert.match(home, new RegExp(`existing-${id}`));
        const env = agentEnv(llm, id, home);
        assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-oauth');
        assert.equal(env.ANTHROPIC_API_KEY, 'inherited-key');
        assert.equal(env.STUDIO_CODEX_API_KEY, process.env.STUDIO_CODEX_API_KEY);
      }
      llm.claudeAuth = 'api';
      const home = agentHome(llm, 'claude', 'runtime', 'project');
      assert.equal(home, path.join('runtime', 'projects', 'project', 'claude-home'));
      const env = agentEnv(llm, 'claude', home);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, 'studio-claude-key');
    }
  );
});

test('CLI probes separate signed-in, signed-out and unknown; Codex catalog contains no secrets', async () => {
  for (const id of ['codex', 'claude']) {
    const login = await probeLogin(id, fixture);
    assert.equal(login.status, 'signed-in');
    assert(!JSON.stringify(login).includes('fixture@example.test'));
    if (id === 'codex') assert.equal(login.models[0].id, 'fixture-model');
    await environment({ STUDIO_FIXTURE_ACCOUNT: 'signed-out' }, async () => {
      assert.equal((await probeLogin(id, fixture)).status, 'signed-out');
    });
  }
  assert.equal(
    (await probeLogin('claude', path.join(os.tmpdir(), 'absent-cli.exe'))).status,
    'unknown'
  );
});

test('Codex CLI mode uses account auth, inherited model, scoped tools and matching thread resume', async () => {
  const ctx = await context('codex'),
    trace = path.join(ctx.runtimeDir, 'trace.jsonl');
  try {
    await environment({ STUDIO_FIXTURE_TRACE: trace }, async () => {
      const adapter = new CodexAdapter();
      assert.equal(await adapter.execute(ctx), '# fixture Codex');
      await adapter.execute(ctx);
      let entries = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
      const start = entries.find((m) => m.method === 'thread/start');
      assert.equal(start.params.model, undefined);
      assert.equal(start.params.modelProvider, undefined);
      assert.equal(start.params.config.model_providers, undefined);
      assert.equal(start.params.config.mcp_servers.inherited.enabled, false);
      assert(entries.some((m) => m.method === 'thread/resume'));
      await environment({ STUDIO_FIXTURE_ACCOUNT: 'changed-account' }, () => adapter.execute(ctx));
      entries = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(entries.filter((m) => m.method === 'thread/start').length, 2);
      await environment({ STUDIO_FIXTURE_ACCOUNT: 'signed-out' }, () =>
        assert.rejects(adapter.execute(ctx), /codex login/)
      );
    });
  } finally {
    await fs.rm(ctx.runtimeDir, { recursive: true, force: true });
  }
});

test('Claude -p preserves CLI auth, streams input, resumes scoped sessions and invalidates account changes', async () => {
  const ctx = await context('claude'),
    launches = [];
  const adapter = new ClaudeAdapter((file, args, cwd, env) => {
    launches.push({ args, env });
    return new ClaudeProcess(file, args, cwd, env);
  });
  try {
    assert.equal(await adapter.execute(ctx), '# fixture Claude');
    const first = launches[0];
    assert(first.args.includes('-p'));
    assert(first.args.includes('stream-json'));
    assert.equal(first.args[first.args.indexOf('--tools') + 1], '');
    assert.equal(first.args.includes('--bare'), false);
    assert.equal(first.args.includes('--model'), false);
    assert.equal(first.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY);
    assert.equal(first.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
    await adapter.execute(ctx);
    assert(launches[1].args.includes('--resume'));
    await environment({ STUDIO_FIXTURE_ACCOUNT: 'changed-account' }, () => adapter.execute(ctx));
    assert.equal(launches[2].args.includes('--resume'), false);
    await environment({ STUDIO_FIXTURE_ACCOUNT: 'signed-out' }, () =>
      assert.rejects(adapter.execute(ctx), /claude auth login/)
    );
    ctx.prompt = 'invalid';
    await assert.rejects(adapter.execute(ctx), /JSONL/);
    ctx.prompt = 'hang';
    const run = adapter.execute(ctx);
    setTimeout(() => ctx.controller.abort(new Error('cancel fixture')), 200);
    await assert.rejects(run, /cancel fixture/);
  } finally {
    await fs.rm(ctx.runtimeDir, { recursive: true, force: true });
  }
});

test('connection tests use ephemeral CLI sessions and leave shared home untouched', async () => {
  const ctx = await context('claude'),
    shared = path.join(ctx.runtimeDir, 'shared-home');
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, 'sentinel'), 'keep');
  try {
    await environment({ CLAUDE_CONFIG_DIR: shared, CODEX_HOME: shared }, async () => {
      for (const backend of ['claude', 'codex']) {
        ctx.settings.llm.backend = backend;
        const trace = path.join(ctx.runtimeDir, `${backend}-trace`);
        await environment({ STUDIO_FIXTURE_TRACE: trace }, async () => {
          const result = await testAgent(
            ctx.settings,
            ctx.runtimeDir,
            new AbortController(),
            () => {}
          );
          assert(result.reply.includes('fixture'));
          const entries = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
          if (backend === 'claude')
            assert(entries.some((e) => e.args?.includes('--no-session-persistence')));
          else
            assert.equal(entries.find((e) => e.method === 'thread/start').params.ephemeral, true);
        });
      }
      assert.equal(await fs.readFile(path.join(shared, 'sentinel'), 'utf8'), 'keep');
    });
  } finally {
    await fs.rm(ctx.runtimeDir, { recursive: true, force: true });
  }
});

test('stopping either CLI waits for its descendant to exit before cleaning the working directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cli-tree-'));
  try {
    for (const id of ['codex', 'claude']) {
      const trace = path.join(root, `${id}-trace`);
      await environment({ STUDIO_FIXTURE_TRACE: trace, STUDIO_FIXTURE_CHILD: '1' }, async () => {
        const child =
          id === 'codex'
            ? new CodexRpcClient(fixture, ['app-server'], root, process.env)
            : new ClaudeProcess(fixture, ['-p'], root, process.env);
        try {
          await child.start();
          let descendant;
          for (let attempt = 0; attempt < 100 && !descendant; attempt++) {
            const entries = await fs.readFile(trace, 'utf8').catch(() => '');
            descendant = entries
              .split('\n')
              .filter(Boolean)
              .map(JSON.parse)
              .find((e) => e.descendant)?.descendant;
            if (!descendant) await new Promise((r) => setTimeout(r, 10));
          }
          assert(descendant, 'fixture must spawn a live descendant');
          process.kill(descendant, 0);
          await child.close();
          assert.throws(() => process.kill(descendant, 0));
        } finally {
          await child.close();
        }
      });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
