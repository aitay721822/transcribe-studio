function packageArguments(target, arch, platform = process.platform, release = false) {
  const selected = target || (platform === 'darwin' ? 'mac' : 'nsis');
  if (!['mac', 'nsis', 'portable'].includes(selected))
    throw new Error('Unsupported package target');
  const cpu = arch || (selected === 'mac' ? 'arm64' : 'x64');
  if (!['arm64', 'x64'].includes(cpu)) throw new Error('Only arm64 and x64 are supported');
  if (selected === 'mac' && cpu !== 'arm64')
    throw new Error('macOS packages only support Apple Silicon (arm64)');
  if (selected === 'mac' && platform !== 'darwin')
    throw new Error('macOS packages must be built on a Mac with matching native dependencies');
  const args = ['--win', selected, `--${cpu}`, '--publish', 'never'];
  if (selected === 'mac') {
    args.splice(0, 2, '--mac');
    if (release) args.push('--config.forceCodeSigning=true', '--config.mac.notarize=true');
    else args.push('--config.mac.notarize=false');
  }
  return args;
}

module.exports = { packageArguments };
