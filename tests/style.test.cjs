const test = require('node:test');
const assert = require('node:assert/strict');
const { spacingEdits, formatSpacing } = require('../scripts/checks/spacing.cjs');

test('imports and sibling functions require exactly one blank line, preserving attached comments', () => {
  const source = [
    "import path from 'node:path';",
    '/** First function. */',
    'export function first() { return path.sep; } // inline comment',
    '/** Second function. */',
    'function second() { return 2; }',
    '',
    '',
    'const third = () => 3;',
    'const value = 4;',
    '',
  ].join('\n');
  assert.equal(spacingEdits(source, 'fixture.ts').length, 4);
  const formatted = formatSpacing(source, 'fixture.ts');
  assert.match(formatted, /'node:path';\n\n\/\*\* First function/);
  assert.match(formatted, /inline comment\n\n\/\*\* Second function/);
  assert.match(formatted, /return 2; }\n\nconst third/);
  assert.match(formatted, /=> 3;\n\nconst value/);
  assert.equal(spacingEdits(formatted, 'fixture.ts').length, 0);
  assert.equal(formatSpacing(formatted, 'fixture.ts'), formatted);
});

test('class methods, function properties and nested declarations receive spacing', () => {
  const source = [
    "const fs = require('node:fs');",
    'class Draft {',
    '  first() {}',
    '  // Keep this comment on second.',
    '  second() {}',
    '}',
    'const actions = { first: () => 1, second() { return 2; }, value: 3 };',
    'function outer() {',
    '  function one() {}',
    '  function two() {}',
    '  return [one, two];',
    '}',
    '',
  ].join('\n');
  const formatted = formatSpacing(source, 'fixture.cjs');
  assert.match(formatted, /'node:fs'\);\n\nclass Draft/);
  assert.match(formatted, /first\(\) {}\n\n  \/\/ Keep this comment/);
  assert.match(formatted, /first: \(\) => 1,\n\nsecond/);
  assert.match(formatted, /function one\(\) {}\n\n  function two/);
  assert.equal(spacingEdits(formatted, 'fixture.cjs').length, 0);
});

test('formatting preserves literal contents, numeric addition, JSX and declaration meaning', () => {
  const source = [
    'const text = `function first() {}',
    'function second() {}',
    '',
    'literal content`;',
    'const sum = 1 + 2;',
    'const View = () => <div>{text}{sum}</div>;',
    'const keep = "function one() {}\\nfunction two() {}";',
    '',
  ].join('\n');
  const formatted = formatSpacing(source, 'fixture.tsx');
  const literal = source.slice(source.indexOf('`'), source.lastIndexOf('`') + 1);
  assert.ok(formatted.includes(literal));
  assert.ok(formatted.includes('const sum = 1 + 2;'));
  assert.ok(formatted.includes('const View = () => <div>{text}{sum}</div>;'));
  assert.ok(formatted.includes('"function one() {}\\nfunction two() {}"'));
  assert.equal(spacingEdits(formatted, 'fixture.tsx').length, 0);
});
