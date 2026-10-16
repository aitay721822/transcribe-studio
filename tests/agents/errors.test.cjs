const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentError } = require('../../dist/services/agents/errors.cjs');

test('CLI errors separate auth, quota, model access and network failures without leaking inherited keys', () => {
  assert.match(
    agentError(new Error('401 authentication token expired'), 'claude').message,
    /claude auth login/
  );
  assert.match(
    agentError(new Error('401 authentication token expired'), 'codex').message,
    /codex login/
  );
  assert.match(agentError(new Error('429 rate_limit exceeded'), 'claude').message, /額度/);
  assert.match(agentError(new Error('403 model access denied'), 'claude').message, /模型/);
  assert.match(agentError(new Error('fetch failed ECONNREFUSED'), 'codex').message, /網路/);
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-inherited-token';
  try {
    const message = agentError(
      new Error('failure fixture-inherited-token Bearer fixture-secret sk-fixture0123456789'),
      'claude'
    ).message;
    assert(!message.includes('fixture-inherited-token'));
    assert(!message.includes('fixture-secret'));
    assert(!message.includes('sk-fixture'));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});
