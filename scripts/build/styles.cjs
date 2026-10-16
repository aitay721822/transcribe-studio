const fs = require('node:fs/promises');
const path = require('node:path');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

async function compileStyles(root) {
  const from = path.join(root, 'src/ui/styles/foundation/tailwind.css');
  const to = path.join(root, 'dist/ui/styles/tailwind.css');
  const result = await postcss([tailwind({ base: path.join(root, 'src/ui') })]).process(
    await fs.readFile(from, 'utf8'),
    { from, to }
  );
  await fs.writeFile(to, result.css);
}

module.exports = { compileStyles };
