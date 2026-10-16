const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('Biome enforces type safety, template literals and no nested ternaries', (t) => {
  const source = path.join(__dirname, `type-policy-${require('node:crypto').randomUUID()}.ts`);
  fs.writeFileSync(source, '', { flag: 'wx' });
  t.after(() => fs.unlinkSync(source));

  const run = (input) => {
    fs.writeFileSync(source, input);
    return spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/@biomejs/biome/bin/biome'),
        'lint',
        '--config-path=config/biome.json',
        source,
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 }
    );
  };

  const explicit = run('export const identity = (value: any): any => value;\n');
  assert.equal(explicit.status, 1, explicit.stderr);
  assert.match(explicit.stderr, /noExplicitAny/);
  const suppression = run('// @ts-ignore\nexport const value: string = 3;\n');
  assert.equal(suppression.status, 1, suppression.stderr);
  assert.match(suppression.stderr, /noTsIgnore/);
  const concatenation = run("export const greeting = (name: string) => 'Hello ' + name;\n");
  assert.equal(concatenation.status, 1, concatenation.stderr);
  assert.match(concatenation.stderr, /useTemplate/);
  for (const expression of ['first ? 1 : second ? 2 : 3', 'first ? (second ? 1 : 2) : 3']) {
    const nestedTernary = run(`export const value = ${expression};\n`);
    assert.equal(nestedTernary.status, 1, nestedTernary.stderr);
    assert.match(nestedTernary.stderr, /noNestedTernary/);
  }
  const valid = run(
    'export const text = (value: unknown): string => typeof value === "string" ? value : "";\n'
  );
  assert.equal(valid.status, 0, valid.stderr);
});

test('TypeScript rejects implicit any, unchecked errors and invalid IPC argument/result types', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-type-policy-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('studio-type-policy-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const config = path.join(directory, 'tsconfig.json');
  const source = path.join(directory, 'probe.ts');
  fs.writeFileSync(
    config,
    JSON.stringify({
      extends: path.join(root, 'tsconfig.json'),
      compilerOptions: { typeRoots: [path.join(root, 'node_modules/@types')] },
      include: [],
      files: [source],
    })
  );
  const bridge = `import type { StudioBridge } from '${path.join(root, 'src/domain/models').replaceAll('\\', '/')}';\ndeclare const bridge: StudioBridge;\n`;

  const run = (code) => {
    fs.writeFileSync(source, `${bridge}${code}`);
    return spawnSync(
      process.execPath,
      [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', config],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 }
    );
  };

  const invalid = run(`
    export function implicit(value) { return value; }
    try { throw new Error('failure'); } catch (error) { console.log(error.message); }
    bridge.invoke('meeting:get', 123);
    bridge.invoke('meeting:get', 'id').then(meeting => { const value: number = meeting.notes; });
  `);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /TS7006/);
  assert.match(invalid.stdout, /TS2339|TS18046/);
  assert.match(invalid.stdout, /TS2345/);
  assert.match(invalid.stdout, /TS2322/);
  const valid = run(`
    export function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
    try { throw new Error('failure'); } catch (error) { if (error instanceof Error) console.log(error.message); }
    bridge.invoke('meeting:get', 'id').then(meeting => { const value: string = meeting.notes; });
  `);
  assert.equal(valid.status, 0, `${valid.stdout}${valid.stderr}`);
});
