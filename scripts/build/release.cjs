const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function validateTag(tag, version) {
  if (tag !== version && tag !== `v${version}`)
    throw new Error(`Release tag must match package.json version ${version}; received ${tag}`);
}

function artifactNames(version) {
  return [`Transcribe Studio Setup ${version}.exe`, `Transcribe Studio ${version}-arm64.dmg`];
}

async function releaseAssets(directory, version) {
  const names = artifactNames(version);
  const checksums = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const info = await fs.stat(file);
    if (!info.isFile() || !info.size) throw new Error(`Missing or empty release artifact: ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    checksums.push(`${hash.digest('hex')}  ${name}`);
  }
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  return [...names, 'SHA256SUMS.txt'].map((name) => path.join(directory, name));
}

function github(args, capture = false) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  return result;
}

async function publishRelease(tag, version, directory, run = github) {
  validateTag(tag, version);
  const files = await releaseAssets(directory, version);
  const existing = run(['release', 'view', tag, '--json', 'isDraft'], true);
  const prerelease = version.includes('-');
  const create = [
    'release',
    'create',
    tag,
    ...files,
    '--verify-tag',
    '--generate-notes',
    '--title',
    `Transcribe Studio ${version}`,
  ];
  if (prerelease) create.push('--prerelease');
  const args = existing.status === 0 ? ['release', 'upload', tag, ...files, '--clobber'] : create;
  if (run(args).status !== 0) throw new Error('GitHub Release asset upload failed');
  if (existing.status === 0 && JSON.parse(existing.stdout).isDraft) {
    if (run(['release', 'edit', tag, '--draft=false', `--prerelease=${prerelease}`]).status !== 0)
      throw new Error('GitHub Release publication failed');
  }
}

if (require.main === module) {
  const { version } = require('../../package.json');

  const tag = process.env.GITHUB_REF_NAME || '';
  Promise.resolve()
    .then(async () => {
      validateTag(tag, version);
      if (process.argv[2] === 'publish')
        await publishRelease(tag, version, path.resolve('release'));
      else if (process.argv[2] !== 'validate') throw new Error('Expected validate or publish');
      console.log(`Release ${tag}: ${process.argv[2]} completed`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { validateTag, artifactNames, releaseAssets, publishRelease };
