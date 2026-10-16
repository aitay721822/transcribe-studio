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

function packageEnvironment(platform = process.platform, release = false, source = process.env) {
  const env = {
    ...source,
    ELECTRON_BUILDER_COMPRESSION_LEVEL: source.ELECTRON_BUILDER_COMPRESSION_LEVEL || '5',
  };
  if (platform !== 'darwin') return env;
  if (release) {
    const required = ['CSC_LINK', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
    const missing = required.filter((name) => !env[name]?.trim());
    if (missing.length)
      throw new Error(
        `Signed macOS release requires: ${missing.join(', ')}. Configure the release secrets before packaging.`
      );
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  } else {
    // Empty CSC_LINK resolves to cwd in electron-builder; verification builds never import certificates.
    for (const name of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'CSC_NAME',
      'CSC_KEYCHAIN',
      'CSC_INSTALLER_LINK',
      'CSC_INSTALLER_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ])
      delete env[name];
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }
  return env;
}

module.exports = { packageArguments, packageEnvironment };
