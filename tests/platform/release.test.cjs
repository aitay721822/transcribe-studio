const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  validateTag,
  artifactNames,
  releaseAssets,
  publishRelease,
} = require('../../scripts/build/release.cjs');

async function fixture(t, version = '0.4.1') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-release-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('studio-release-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const name of artifactNames(version)) await fs.writeFile(path.join(directory, name), name);
  return directory;
}

test('release tags must match the package version, including prereleases', () => {
  validateTag('v0.4.1', '0.4.1');
  validateTag('0.4.1', '0.4.1');
  validateTag('v0.4.2-beta.1', '0.4.2-beta.1');
  for (const tag of ['v0.4.0', '', 'latest', 'v0.4.1-extra'])
    assert.throws(() => validateTag(tag, '0.4.1'), /must match/);
});

test('release assets require both platforms and checksum every installer with spaces intact', async (t) => {
  const directory = await fixture(t);
  const files = await releaseAssets(directory, '0.4.1');
  assert.equal(files.length, 3);
  assert.deepEqual(artifactNames('0.4.1'), [
    'Transcribe Studio Setup 0.4.1.exe',
    'Transcribe Studio 0.4.1-arm64.dmg',
  ]);
  const lines = (await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8'))
    .trim()
    .split('\n');
  assert.deepEqual(
    lines,
    artifactNames('0.4.1').map(
      (name) => `${createHash('sha256').update(name).digest('hex')}  ${name}`
    )
  );
  await fs.writeFile(files[0], '');
  await assert.rejects(releaseAssets(directory, '0.4.1'), /empty release artifact/);
});

test('new prereleases publish complete artifacts with a verified tag and generated notes', async (t) => {
  const version = '0.4.2-beta.1';
  const directory = await fixture(t, version);
  const calls = [];
  await publishRelease(`v${version}`, version, directory, (args) => {
    calls.push(args);
    return { status: args[1] === 'view' ? 1 : 0 };
  });
  assert.equal(calls[1][1], 'create');
  assert(calls[1].includes('--verify-tag'));
  assert(calls[1].includes('--generate-notes'));
  assert(calls[1].includes('--prerelease'));
  for (const name of artifactNames(version)) assert(calls[1].includes(path.join(directory, name)));
});

test('reruns upload existing releases; draft publication waits for successful uploads', async (t) => {
  const directory = await fixture(t);
  const calls = [];
  await publishRelease('v0.4.1', '0.4.1', directory, (args) => {
    calls.push(args);
    return { status: 0, stdout: '{"isDraft":true}' };
  });
  assert.equal(calls[1][1], 'upload');
  assert(calls[1].includes('--clobber'));
  assert(calls[2].includes('--draft=false'));
  let published = false;
  await assert.rejects(
    publishRelease('v0.4.1', '0.4.1', directory, (args) => {
      if (args[1] === 'edit') published = true;
      return { status: args[1] === 'upload' ? 1 : 0, stdout: '{"isDraft":true}' };
    }),
    /upload failed/
  );
  assert.equal(published, false);
  await fs.unlink(path.join(directory, artifactNames('0.4.1')[0]));
  await assert.rejects(
    publishRelease('v0.4.1', '0.4.1', directory, () =>
      assert.fail('Missing installers must not publish')
    )
  );
});
