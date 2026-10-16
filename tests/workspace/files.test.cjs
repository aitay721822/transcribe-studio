const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const workspace = require('../../dist/services/workspace/files.cjs');

after(() => workspace.closeWorkspace());

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-huge-workspace-'));
  const roots = [{ id: 'a', name: 'A', path: directory }];
  try {
    await run(directory, roots);
  } finally {
    await workspace.closeWorkspace();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('streamed listing and search exceed 500 files, 10000 entries and 10 directory levels without losing pages', async () =>
  fixture(async (directory, roots) => {
    for (let i = 0; i < 10700; i += 100)
      await Promise.all(
        Array.from({ length: 100 }, (_, n) =>
          fs.writeFile(
            path.join(
              directory,
              `${String(i + n).padStart(5, '0')}${i + n < 10050 ? '.bin' : '.txt'}`
            ),
            i + n < 10050 ? '' : `MATCH-${i + n}`
          )
        )
      );
    const deep = path.join(directory, ...Array.from({ length: 14 }, (_, i) => `d${i}`));
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'deep.txt'), 'deep-needle');
    const all = [],
      tokens = [];
    let cursor, page;
    do {
      page = await workspace.listFiles(roots, '', { cursor, limit: 73 });
      all.push(...page.files);
      cursor = page.nextCursor;
      if (cursor) tokens.push(cursor);
    } while (cursor);
    assert.equal(all.length, 651);
    assert.equal(new Set(all.map((f) => f.relative)).size, 651);
    assert.ok(page.stats.visited > 10000);
    assert.ok(all.some((f) => f.relative.endsWith('deep.txt')));
    await assert.rejects(workspace.listFiles(roots, '', { cursor: tokens[0] }), /失效/);
    const hits = [];
    cursor = undefined;
    do {
      page = await workspace.searchFiles(roots, 'MATCH-', { cursor, limit: 37 });
      hits.push(...page.matches);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(hits.length, 650);
    assert.equal(page.stats.errorCount, 0);
    assert.equal(page.complete, true);
    const deepHits = await workspace.searchFiles(roots, 'deep-needle', { pathQuery: 'deep.txt' });
    assert.equal(deepHits.matches.length, 1);
  }));
test('search streams text past 8MB/80000 chars, spans chunk boundaries, and returns every matching line via cursor', async () =>
  fixture(async (directory, roots) => {
    const text =
      'a'.repeat(65533) +
      '跨界詞' +
      '\n' +
      'b'.repeat(9 * 1024 * 1024) +
      '\nend-needle\n' +
      'same-hit\n'.repeat(125);
    await fs.writeFile(path.join(directory, 'large.log'), text);
    const boundary = await workspace.searchFiles(roots, '跨界詞');
    assert.equal(boundary.matches[0].line, 1);
    const late = await workspace.searchFiles(roots, 'end-needle');
    assert.equal(late.matches[0].line, 3);
    assert.ok(late.matches[0].offset > 8 * 1024 * 1024);
    const read = await workspace.readFilePage(roots, 'a', 'large.log', {
      offset: late.matches[0].offset,
      version: late.matches[0].version,
    });
    assert.match(read.text, /end-needle/);
    let cursor,
      count = 0;
    do {
      const page = await workspace.searchFiles(roots, 'same-hit', { cursor, limit: 11 });
      count += page.matches.length;
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(count, 125);
  }));
test('UTF-8 and UTF-16 pages preserve every character, next offsets and file version checks', async () =>
  fixture(async (directory, roots) => {
    for (const encoding of ['utf8', 'utf16le']) {
      const text = `${encoding === 'utf16le' ? '\ufeff' : ''}${'中🙂繁體\n'.repeat(50)}`;
      const filename = `${encoding}.txt`;
      await fs.writeFile(path.join(directory, filename), Buffer.from(text, encoding));
      let offset = 0,
        result = '',
        version;
      do {
        const page = await workspace.readFilePage(roots, 'a', filename, {
          offset,
          limit: 7,
          version,
        });
        result = `${result}${page.text}`;
        version = page.version;
        offset = page.nextOffset;
      } while (offset !== null);
      assert.equal(result, text);
      assert.ok(!result.includes('�'));
      await fs.appendFile(path.join(directory, filename), 'changed');
      await assert.rejects(
        workspace.readFilePage(roots, 'a', filename, { offset: 0, version }),
        /變更/
      );
    }
  }));
test('cursors bind roots/query, support cancellation, reject escapes/secrets/junctions and report read errors', async () =>
  fixture(async (directory, roots) => {
    await fs.writeFile(path.join(directory, 'a.txt'), 'needle\n'.repeat(100));
    await fs.writeFile(path.join(directory, '.env.local'), 'needle SECRET');
    await fs.writeFile(path.join(directory, 'binary.txt'), Buffer.from([0, 1, 2]));
    const first = await workspace.searchFiles(roots, 'needle', { limit: 1 });
    await assert.rejects(
      workspace.searchFiles(roots, 'different', { cursor: first.nextCursor }),
      /查詢/
    );
    await assert.rejects(
      workspace.searchFiles([{ ...roots[0], id: 'other' }], 'needle', { cursor: first.nextCursor }),
      /資料夾/
    );
    const continued = await workspace.searchFiles(roots, 'needle', {
      cursor: first.nextCursor,
      limit: 1,
    });
    assert.equal(
      continued.matches.length,
      1,
      'invalid query must not destroy the valid scan cursor'
    );
    workspace.releaseCursor(continued.nextCursor);
    const controller = new AbortController();
    await assert.rejects(
      workspace.listFiles(roots, '', {
        signal: controller.signal,

        onProgress: () => controller.abort(new Error('stop')),
      }),
      /stop/
    );
    await assert.rejects(workspace.readFilePage(roots, 'a', '../outside.txt'), /超出/);
    await assert.rejects(workspace.readFilePage(roots, 'a', '.env.local'), /排除/);
    await fs.symlink(
      directory,
      path.join(directory, 'loop'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await assert.rejects(workspace.readFilePage(roots, 'a', 'loop/a.txt'), /連結/);
    let cursor, last;
    do {
      last = await workspace.searchFiles(roots, 'absent', { cursor });
      cursor = last.nextCursor;
    } while (cursor);
    assert.equal(last.stats.errorCount, 1);
    assert.ok(last.errors.some((e) => e.includes('二進位')));
  }));
