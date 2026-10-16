const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { bundledClaudeModule } = require('../../dist/services/agents/bundled.cjs');
const { posixCommand, prepareRuntimePath } = require('../../dist/services/agents/posix.cjs');
const { executableCandidates } = require('../../dist/services/agents/executable.cjs');
const { stopChild } = require('../../dist/transport/runtime/process.cjs');

test('bundled Claude resolves native Darwin and Windows architectures', () => {
  for (const arch of ['arm64', 'x64']) {
    assert.equal(
      bundledClaudeModule('darwin', arch),
      `@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`
    );
    assert.equal(
      bundledClaudeModule('win32', arch),
      `@anthropic-ai/claude-agent-sdk-win32-${arch}/claude.exe`
    );
  }
  assert.throws(() => bundledClaudeModule('darwin', 'ia32'), /沒有隨附/);
});

test('Finder-like empty PATH discovers nvm and executes extensionless Node entry with intact arguments', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio POSIX 中文 '));
  try {
    const bin = path.join(home, '.nvm/versions/node/v24.5.0/bin');
    await fs.mkdir(bin, { recursive: true });
    const file = path.join(bin, 'codex');
    await fs.writeFile(
      file,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));'
    );
    await fs.chmod(file, 0o755);
    const env = { HOME: home, PATH: '' };
    await prepareRuntimePath('darwin', env);
    assert.ok(env.PATH.includes(bin));
    assert.ok(
      (await executableCandidates('codex', '', { HOME: home, PATH: '' }, 'darwin')).includes(file)
    );
    const command = await posixCommand(file);
    assert.equal(command.executable, process.execPath);
    const args = ['空白 argument', 'literal $() ` & |', ''];
    const child = spawn(command.executable, [...command.args, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for await (const chunk of child.stdout) output = `${output}${chunk}`;
    assert.deepEqual(JSON.parse(output), args);
  } finally {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('studio POSIX'));
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('POSIX cancellation escalates SIGTERM to SIGKILL once and bounds retained pipes', async () => {
  const child = new EventEmitter();
  const signals = [];
  Object.assign(child, {
    pid: 123456,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),

    kill: (signal) => signals.push(signal),
  });
  const groups = [];
  const options = {
    platform: 'darwin',
    graceMs: 10,
    deadlineMs: 30,

    killGroup: (pid, signal) => groups.push([pid, signal]),
  };
  const first = stopChild(child, options);
  assert.equal(stopChild(child, options), first);
  await first;
  assert.deepEqual(groups[0], [-123456, 'SIGTERM']);
  assert.ok(groups.some((entry) => entry[1] === 'SIGKILL'));
  assert.equal(signals.length, 0);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.listenerCount('close'), 0);
});

test('POSIX cancellation falls back to the individual child when its group is absent', async () => {
  const child = new EventEmitter();
  const signals = [];
  Object.assign(child, {
    pid: 123456,
    exitCode: null,
    signalCode: null,

    kill: (signal) => {
      signals.push(signal);
      queueMicrotask(() => child.emit('close'));
    },
  });
  await stopChild(child, {
    platform: 'darwin',
    graceMs: 10,
    deadlineMs: 30,

    killGroup: () => {
      throw new Error('ESRCH');
    },
  });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('an exited CLI cannot leave cancellation hanging on inherited descendant pipes', async () => {
  const child = new EventEmitter();
  const groups = [];
  Object.assign(child, {
    pid: 123456,
    exitCode: 0,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),

    kill: () => false,
  });
  await stopChild(child, {
    platform: 'darwin',
    graceMs: 10,
    deadlineMs: 30,

    killGroup: (pid, signal) => groups.push([pid, signal]),
  });
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.ok(groups.some((entry) => entry[1] === 'SIGKILL'));
});

test('real POSIX process that ignores SIGTERM is reaped after escalation', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    ],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  await new Promise((resolve) => child.stdout.once('data', resolve));
  await stopChild(child, { graceMs: 30, deadlineMs: 1000 });
  assert.equal(child.signalCode, 'SIGKILL');
});
