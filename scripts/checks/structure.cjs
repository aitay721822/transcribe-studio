const fs = require('node:fs');
const path = require('node:path');
const { maintainedEntries } = require('./sources.cjs');

const root = path.resolve(__dirname, '../..');
const limits = { lines: 500, files: 10, folders: 10 };
const errors = [];
let checkedFiles = 0;
let checkedDirectories = 0;

function checkLines(filename) {
  if (
    ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json'].includes(
      path.basename(filename)
    ) ||
    !/\.(tsx?|[cm]?js|css|html|json|md|py|ps1|sh|ya?ml|toml|sql|svg|txt|cs)$/.test(filename)
  )
    return;
  const text = fs.readFileSync(filename, 'utf8');
  const lines = text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : 0;
  checkedFiles++;
  if (
    /\.[cm]?tsx?$/.test(filename) &&
    /^\s*(?:\/\/|\/\*|\*)\s*@ts-(?:ignore|nocheck)\b/m.test(text)
  )
    errors.push(
      `${path.relative(root, filename)}: TypeScript suppression directives are forbidden`
    );
  if (lines > limits.lines)
    errors.push(
      `${path.relative(root, filename)}: ${lines} lines; maximum 500, split by responsibility`
    );
}

function visit(dir) {
  const entries = maintainedEntries(dir, root);
  const files = entries.filter((e) => e.isFile());
  const dirs = entries.filter((e) => e.isDirectory());
  checkedDirectories++;
  if (files.length > limits.files || dirs.length > limits.folders)
    errors.push(
      (path.relative(root, dir) || '.') +
        ': ' +
        files.length +
        ' files, ' +
        dirs.length +
        ' folders; maximum 10 files / 10 folders, group by business responsibility'
    );
  for (const file of files) checkLines(path.join(dir, file.name));
  for (const entry of dirs) visit(path.join(dir, entry.name));
}

visit(root);
const outside = fs
  .readdirSync(path.join(root, 'src'), { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name);
if (outside.length !== 1 || outside[0] !== 'main.ts')
  errors.push('src must contain only main.ts outside business folders');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Structure verified: ${checkedFiles} text files / ${checkedDirectories} maintained directories; maximum 500 lines per source file, 10 files / 10 folders per directory.`
  );
