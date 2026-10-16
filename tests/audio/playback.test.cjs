const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { recordingResponse } = require('../../dist/desktop/platform/recording.cjs');

async function fixture(t, size = 131079) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-media-ranges-'));
  const filename = path.join(directory, 'recording.wav');
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  await fs.writeFile(filename, bytes);
  t.after(async () => {
    await fs.unlink(filename);
    await fs.rmdir(directory);
  });
  return { filename, bytes, directory };
}

function request(range, method = 'GET') {
  return new Request('https://local/recording', { method, headers: range ? { Range: range } : {} });
}

test('recording playback advertises seekable byte ranges and preserves full and HEAD responses', async (t) => {
  const { filename, bytes } = await fixture(t);
  const response = await recordingResponse(request(), filename);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const head = await recordingResponse(request('bytes=0-10', 'HEAD'), filename);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(head.body, null);
});

test('recording playback streams exact bounded, open-ended and suffix ranges, including EOF clamps', async (t) => {
  const { filename, bytes } = await fixture(t);
  for (const [range, start, end] of [
    ['bytes=0-3', 0, 3],
    ['bytes=65000-66000', 65000, 66000],
    ['bytes=123456-', 123456, bytes.length - 1],
    ['bytes=-17', bytes.length - 17, bytes.length - 1],
    ['bytes=5-99999999', 5, bytes.length - 1],
    ['bytes=-99999999', 0, bytes.length - 1],
  ]) {
    const response = await recordingResponse(request(range), filename);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const response = await recordingResponse(request(), filename);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert(chunk.value.length <= 65536);
  await reader.cancel();
});

test('recording playback rejects invalid ranges and methods, and handles missing, directory and empty files', async (t) => {
  const { filename, bytes, directory } = await fixture(t);
  for (const range of [
    'bytes=8-3',
    `bytes=${bytes.length}-`,
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,4-5',
    'bytes=9007199254740992-',
  ]) {
    const response = await recordingResponse(request(range), filename);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
  }
  assert.equal((await recordingResponse(request(undefined, 'POST'), filename)).status, 405);
  assert.equal(
    (await recordingResponse(request(), path.join(directory, 'missing.wav'))).status,
    404
  );
  assert.equal((await recordingResponse(request(), directory)).status, 404);
  await fs.writeFile(filename, Buffer.alloc(0));
  const empty = await recordingResponse(request(), filename);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal((await recordingResponse(request('bytes=0-'), filename)).status, 416);
});
