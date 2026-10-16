const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { probeVersion, detectAgents } = require('../../dist/services/agents/detection.cjs');
const { setupReadiness } = require('../../dist/domain/readiness.cjs');
const { executableCandidates } = require('../../dist/services/agents/executable.cjs');
const { DEFAULTS } = require('../../dist/persistence/store.cjs');
const { createSetupGate } = require('../../dist/ui/setup/gate.cjs');

test('setup always requires offline transcription and Agent; realtime is optional until enabled', () => {
  const s = structuredClone(DEFAULTS);
  assert.equal(setupReadiness(s).complete, false);
  s.asr.provider = 'openai';
  s.asr.apiKey = 'configured-realtime-key';
  s.llm.apiKey = '••••••••';
  s.llm.model = 'selected';
  assert.equal(setupReadiness(s).asr, false);
  assert.equal(setupReadiness(s).offline, false);
  assert.equal(setupReadiness(s).realtime, true);
  s.asr.provider = 'transcriptions';
  s.asr.fileUrl = 'http://localhost:8000/v1/audio/transcriptions';
  s.asr.fileApiKey = '';
  s.asr.url = '';
  s.asr.model = '';
  s.asr.apiKey = '';
  assert.equal(setupReadiness(s).asr, true);
  assert.equal(setupReadiness(s).complete, true);
  assert.equal(setupReadiness(s).realtime, false);
  s.asr.provider = 'openai';
  assert.equal(setupReadiness(s).complete, false);
  s.asr.url = 'ws://localhost:8000/v1/realtime';
  s.asr.model = 'local-realtime-model';
  assert.equal(setupReadiness(s).complete, true);
  s.asr.fileModel = '';
  assert.equal(setupReadiness(s).complete, false);
  s.asr.fileModel = 'local-file-model';
  s.llm.backend = 'claude';
  s.llm.claudeAuth = 'api';
  assert.equal(setupReadiness(s).agent, false);
  s.llm.claudeKey = '••••••••';
  s.llm.claudeModel = 'selected';
  assert.equal(setupReadiness(s).complete, true);
  s.asr.provider = 'transcriptions';
  assert.equal(setupReadiness(s).asr, true);
});

test('agent probe handles spaces, npm shims, missing executable and hung version without reading credentials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio agents '));
  const good = path.join(directory, 'good.cjs');
  const hung = path.join(directory, 'hung.cjs');
  fs.writeFileSync(good, 'console.log("codex 1.2.3");');
  fs.writeFileSync(hung, 'setInterval(() => {}, 1000);');
  assert.equal(await probeVersion(good), 'codex 1.2.3');
  await assert.rejects(probeVersion(hung, 100), /逾時/);
  const packages = path.join(directory, 'node_modules/@openai/codex');
  fs.mkdirSync(packages, { recursive: true });
  fs.writeFileSync(path.join(directory, 'codex.cmd'), 'ignored shell text');
  fs.writeFileSync(path.join(directory, 'codex'), '#!/bin/sh\nexit 0');
  assert.deepEqual(
    await executableCandidates('codex', '', { PATH: directory, PATHEXT: '.CMD' }, 'win32'),
    [path.join(directory, 'codex.cmd')]
  );
  fs.writeFileSync(
    path.join(packages, 'package.json'),
    JSON.stringify({ bin: { codex: 'bin.cjs' } })
  );
  fs.writeFileSync(path.join(packages, 'bin.cjs'), 'console.log("codex npm 2.0");');
  const result = await detectAgents({
    ...DEFAULTS.llm,
    codexPath: path.join(directory, 'codex.cmd'),
    claudePath: path.join(directory, 'missing.exe'),
  });
  assert.equal(result[0].runnable, true);
  assert.equal(result[0].version, 'codex npm 2.0');
  assert.equal(result[0].configured, true);
  assert.equal(result[0].login.status, 'unknown');
  assert.equal(result[1].installed, false);
});

test('CLI revalidation keeps an already usable workspace open and never unlocks stale settings', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.llm.backend = 'claude';
  settings.llm.claudeAuth = 'cli';
  settings.asr.fileUrl = 'http://127.0.0.1:9001/v1/audio/transcriptions';
  const state = { settings, setupLocked: false };
  let resolve;
  const gate = createSetupGate(
    state,
    () =>
      new Promise((yes) => {
        resolve = yes;
      })
  );
  const checking = gate();
  assert.equal(
    state.setupLocked,
    false,
    'saving cannot temporarily redirect ordinary clicks to setup'
  );
  resolve([{ id: 'claude', runnable: true }]);
  assert.equal(await checking, true);
  state.setupLocked = true;
  const startup = gate();
  assert.equal(state.setupLocked, true, 'startup stays locked until installation is confirmed');
  resolve([{ id: 'claude', runnable: true }]);
  assert.equal(await startup, true);
  const old = gate();
  settings.llm.claudeAuth = 'api';
  settings.llm.claudeKey = '';
  assert.equal(await gate(), false);
  resolve([{ id: 'claude', runnable: true }]);
  assert.equal(await old, false);
  assert.equal(state.setupLocked, true);
});
