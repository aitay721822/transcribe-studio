const { parse } = require('@babel/parser');

function syntax(source, filename) {
  return parse(source, {
    sourceType: 'unambiguous',
    plugins: [
      ...(/\.[cm]?tsx?$/.test(filename) ? ['typescript'] : []),
      ...(/\.[jt]sx$/.test(filename) ? ['jsx'] : []),
    ],
  });
}

function expression(node) {
  while (
    node &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'ParenthesizedExpression',
    ].includes(node.type)
  )
    node = node.expression;
  return node;
}

function isImport(node) {
  if (['ImportDeclaration', 'TSImportEqualsDeclaration'].includes(node.type)) return true;
  return (
    node.type === 'VariableDeclaration' &&
    node.declarations.every((entry) => {
      const init = expression(entry.init);
      return (
        init?.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === 'require'
      );
    })
  );
}

function isFunction(node) {
  if (['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(node.type))
    return node.declaration ? isFunction(node.declaration) : false;
  if (
    [
      'FunctionDeclaration',
      'TSDeclareFunction',
      'ClassMethod',
      'ClassPrivateMethod',
      'ObjectMethod',
    ].includes(node.type)
  )
    return true;
  if (node.type === 'VariableDeclaration')
    return node.declarations.some((entry) => isFunction(expression(entry.init) || {}));
  if (['ClassProperty', 'ClassPrivateProperty', 'ObjectProperty'].includes(node.type))
    return isFunction(expression(node.value) || {});
  return ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type);
}

function boundary(source, previous, next) {
  let end = previous.end;
  let start = next.start;
  for (const comment of previous.trailingComments || [])
    if (comment.loc.start.line === previous.loc.end.line && comment.end <= next.start)
      end = Math.max(end, comment.end);
  for (const comment of next.leadingComments || [])
    if (comment.start >= end && comment.loc.start.line > previous.loc.end.line)
      start = Math.min(start, comment.start);
  const gap = source.slice(end, start);
  if (!/^[\s,;]*$/.test(gap)) return null;
  const first = gap.indexOf('\n');
  const last = gap.lastIndexOf('\n');
  const replacement =
    first < 0
      ? `${gap.trimEnd()}\n\n`
      : `${gap.slice(0, first).replace(/\r$/, '')}\n\n${gap.slice(last + 1)}`;
  return gap === replacement
    ? null
    : { start: end, end: start, replacement, line: next.loc.start.line };
}

function spacingEdits(source, filename) {
  const edits = [];

  function list(nodes) {
    for (let index = 1; index < nodes.length; index++) {
      const previous = nodes[index - 1];
      const next = nodes[index];
      if (!previous || !next) continue;
      if (isFunction(previous) || isFunction(next) || (isImport(previous) && !isImport(next))) {
        const edit = boundary(source, previous, next);
        if (edit) edits.push(edit);
      }
    }
  }

  function visit(node) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (
      ['Program', 'BlockStatement', 'ClassBody', 'StaticBlock', 'TSModuleBlock'].includes(node.type)
    )
      list(node.body);
    else if (node.type === 'ObjectExpression') list(node.properties);
    else if (node.type === 'SwitchCase') list(node.consequent);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'leadingComments', 'trailingComments', 'innerComments', 'comments'].includes(key))
        continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }

  visit(syntax(source, filename));
  return edits.sort((a, b) => b.start - a.start);
}

function formatSpacing(source, filename) {
  for (const edit of spacingEdits(source, filename))
    source = `${source.slice(0, edit.start)}${edit.replacement}${source.slice(edit.end)}`;
  return source;
}

module.exports = { syntax, spacingEdits, formatSpacing };
