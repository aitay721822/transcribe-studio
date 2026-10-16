const fs = require('node:fs');
const path = require('node:path');

const generated = new Set(['.git', 'node_modules', 'dist', 'release', 'output', 'test-results']);

function maintainedEntries(directory, root) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !(directory === root && entry.isDirectory() && generated.has(entry.name)));
}

function* sourceFiles(root, directory = root) {
  for (const entry of maintainedEntries(directory, root)) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(root, file);
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) yield file;
  }
}

module.exports = { maintainedEntries, sourceFiles };
