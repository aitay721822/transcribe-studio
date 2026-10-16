const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles } = require('./sources.cjs');
const { spacingEdits, formatSpacing } = require('./spacing.cjs');

const root = path.resolve(__dirname, '../..');
const write = process.argv.includes('--write');
let checked = 0;
let changed = 0;
const errors = [];

for (const filename of sourceFiles(root)) {
  const relative = path.relative(root, filename);
  try {
    const source = fs.readFileSync(filename, 'utf8');
    const edits = spacingEdits(source, filename);
    checked++;
    if (!edits.length) continue;
    if (write) {
      fs.writeFileSync(filename, formatSpacing(source, filename));
      changed++;
    } else {
      for (const edit of edits)
        errors.push(
          `${relative}:${edit.line}: require one blank line after imports and around functions`
        );
    }
  } catch (error) {
    errors.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Spacing verified: ${checked} source files${write ? `, formatted ${changed}` : ''}.`);
}
