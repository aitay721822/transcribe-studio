const path = require('node:path');

function packagedExecutable(
  directory = 'release',
  platform = process.platform,
  arch = process.arch
) {
  if (platform === 'darwin')
    return path.resolve(
      directory,
      arch === 'arm64' ? 'mac-arm64' : 'mac',
      'Transcribe Studio.app/Contents/MacOS/Transcribe Studio'
    );
  return path.resolve(directory, 'win-unpacked/Transcribe Studio.exe');
}

module.exports = { packagedExecutable };
