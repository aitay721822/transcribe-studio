/** Use the development dependency, independently of the machine's CLI installation. */
function claudeCli() {
  const filename = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return require.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${filename}`
  );
}

module.exports = { claudeCli };
