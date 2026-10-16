const fs = require('node:fs/promises');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

/** The SVG is the only design source; native icons are rendered at each target size. */
async function compileBranding(root) {
  const source = await fs.readFile(path.join(root, 'config/branding/icon.svg'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map((size) =>
    new Resvg(source, {
      fitTo: { mode: 'width', value: size },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng()
  );
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frames[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  });
  const output = path.join(root, 'config/branding/native');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'icon.ico'), Buffer.concat([directory, ...frames]));
  await fs.writeFile(path.join(output, 'icon.png'), frames.at(-1));
}

module.exports = { compileBranding };
