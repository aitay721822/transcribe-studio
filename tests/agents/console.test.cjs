const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { spawnHidden } = require('../../dist/transport/runtime/launch.cjs');

function collect(child, input = '') {
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`;
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('Windows CLI and ordinary grandchildren share a hidden console, with intact Unicode pipes and arguments', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio hidden console 空白 '));
  const file = path.join(directory, 'console probe.exe');
  const compiler = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  );
  const compiled = spawnSync(
    compiler,
    ['/nologo', '/target:exe', `/out:${file}`, path.resolve('tests/fixtures/console-probe.cs')],
    { windowsHide: true, encoding: 'utf8' }
  );
  assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);
  try {
    const args = ['空白 argument', 'a"b', 'C:\\path with spaces\\', '', 'literal $() ` & |'];
    const result = await collect(
      spawnHidden(file, args, {
        cwd: directory,
        env: { ...process.env, STUDIO_CONSOLE_TEST: '繼承環境' },
      }),
      '逐字稿輸入\n'
    );
    assert.equal(result.code, 0, result.stderr);
    const rows = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].console, '0', 'a hidden console must exist for descendants to inherit');
    assert.equal(rows[0].console, rows[1].console);
    assert.equal(rows[0].visible, false);
    assert.equal(
      rows[1].visible,
      false,
      'descendant is hidden even without its own windowsHide flag'
    );

    const decode = (value) => Buffer.from(value, 'base64').toString('utf8');

    assert.equal(decode(rows[0].input), '逐字稿輸入');
    assert.deepEqual(decode(rows[0].args).split('\0'), args);
    assert.equal(decode(rows[0].cwd), directory);
    assert.equal(decode(rows[0].env), '繼承環境');
    const failed = await collect(spawnHidden(file, ['--exit']));
    assert.equal(failed.code, 23);
    assert.match(failed.stderr, /fixture stderr/);
    const missing = await collect(spawnHidden(path.join(directory, 'missing.exe'), []));
    assert.equal(missing.code, 127);
    assert.match(missing.stderr, /Cannot start CLI/);
    const wrapper = path.join(directory, 'electron-wrapper.cjs');
    const inner = path.join(directory, 'cli-wrapper.cjs');
    await fs.writeFile(
      inner,
      `
      const child = require('node:child_process').spawn(${JSON.stringify(file)}, ['--child']);
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
      child.on('close', code => { process.exitCode = code; });
    `
    );
    await fs.writeFile(
      wrapper,
      `
      const { spawnHidden } = require(${JSON.stringify(path.resolve('dist/transport/runtime/launch.cjs'))});
      const { launchCommand } = require(${JSON.stringify(path.resolve('dist/services/agents/executable.cjs'))});
      launchCommand(${JSON.stringify(inner)}).then(command => {
        const child = spawnHidden(command.executable, command.args, { env: process.env });
        child.stdin.end(); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
        child.on('close', code => { process.exitCode = code; });
      }).catch(error => { console.error(error.message); process.exitCode = 1; });
    `
    );
    const electron = await collect(
      spawnHidden(require('electron'), [wrapper], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    );
    assert.equal(electron.code, 0, electron.stderr);
    const inspected = JSON.parse(electron.stdout);
    assert.notEqual(
      inspected.console,
      '0',
      'Electron npm wrappers must also inherit a hidden console'
    );
    assert.equal(inspected.visible, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
