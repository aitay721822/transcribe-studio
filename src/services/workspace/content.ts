import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { WorkspaceRoot } from '../../domain/models';
import type { FilePage, ScanStats, WorkspaceArgs, WorkspaceEntry } from '../../domain/workspace';
import { extractDocx } from '../documents/read-docx';
import { safePath, TEXT } from './traversal';

const versionOf = (stat: import('node:fs').Stats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

export function integer(value: unknown, fallback: number, min: number, max: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || typeof n !== 'number' || n < min || n > max)
    throw new Error(`分頁數值須為 ${min}–${max} 的整數`);
  return n;
}

async function open(roots: WorkspaceRoot[], rootId: string, relative: string) {
  const target = await safePath(roots, rootId, relative);
  if (!TEXT.has(path.extname(target).toLowerCase())) throw new Error('此檔案格式尚不支援讀取');
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('不是一般檔案');
    const verified = await safePath(roots, rootId, relative),
      now = await fs.stat(verified);
    if (versionOf(stat) !== versionOf(now)) throw new Error('檔案已變更，請重新讀取');
    return { handle, stat, target, version: versionOf(stat) };
  } catch (caughtE) {
    const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

    await handle.close();
    throw e;
  }
}

async function encoding(handle: import('node:fs/promises').FileHandle): Promise<BufferEncoding> {
  const header = Buffer.alloc(4096),
    { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (header[0] === 0xff && header[1] === 0xfe) return 'utf16le';
  if (header[0] === 0xfe && header[1] === 0xff) throw new Error('UTF-16 BE 尚不支援，請轉為 UTF-8');
  if (header.subarray(0, bytesRead).includes(0)) throw new Error('檔案含二進位內容，已略過');
  return 'utf8';
}

export async function readPage(
  roots: WorkspaceRoot[],
  args: WorkspaceArgs,
  signal: AbortSignal
): Promise<FilePage> {
  const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit = integer(args.limit, 16000, 4, 64000);
  const file = await open(roots, args.rootId, args.relative);
  try {
    signal.throwIfAborted();
    if (args.version && args.version !== file.version)
      throw new Error('檔案已變更，請從 offset 0 重新讀取');
    const citation = `[${roots.find((r) => r.id === args.rootId).name}/${args.relative}]`;
    if (path.extname(file.target).toLowerCase() === '.docx') {
      if (file.stat.size > 32 * 1024 * 1024)
        throw new Error('DOCX 壓縮檔超過 32 MB；請匯出為文字後分段讀取');
      const text = await extractDocx(file.target);
      signal.throwIfAborted();
      if (offset > text.length) throw new Error('offset 超出文件長度');
      if (versionOf(await file.handle.stat()) !== file.version)
        throw new Error('檔案已變更，請重新讀取');
      let end = Math.min(text.length, offset + limit);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      return {
        rootId: args.rootId,
        relative: args.relative,
        text: text.slice(offset, end),
        offset,
        limit,
        total: text.length,
        unit: 'characters',
        version: file.version,
        nextOffset: end < text.length ? end : null,
        citation,
      };
    }
    const enc = await encoding(file.handle);
    if (offset > file.stat.size || (enc === 'utf16le' && offset % 2))
      throw new Error('offset 超出範圍或未對齊字元');
    const buffer = Buffer.alloc(Math.min(limit + 4, file.stat.size - offset));
    const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, offset);
    signal.throwIfAborted();
    let end = Math.min(limit, bytesRead);
    if (enc === 'utf8') {
      if (offset && bytesRead && (buffer[0] & 0xc0) === 0x80)
        throw new Error('offset 未對齊 UTF-8 字元，請沿用 nextOffset');
      if (offset + end < file.stat.size) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    } else {
      if (
        offset &&
        bytesRead >= 2 &&
        buffer.readUInt16LE(0) >= 0xdc00 &&
        buffer.readUInt16LE(0) <= 0xdfff
      )
        throw new Error('offset 未對齊 UTF-16 字元，請沿用 nextOffset');
      end -= end % 2;
      if (end >= 2 && offset + end < file.stat.size) {
        const code = buffer.readUInt16LE(end - 2);
        if (code >= 0xd800 && code <= 0xdbff) end -= 2;
      }
    }
    if (versionOf(await file.handle.stat()) !== file.version)
      throw new Error('檔案已變更，請重新讀取');
    return {
      rootId: args.rootId,
      relative: args.relative,
      text: buffer.subarray(0, end).toString(enc),
      encoding: enc,
      offset,
      limit,
      totalBytes: file.stat.size,
      unit: 'bytes',
      version: file.version,
      nextOffset: offset + end < file.stat.size ? offset + end : null,
      citation,
    };
  } finally {
    await file.handle.close();
  }
}

/** One hit per matching line; long lines use bounded windows rather than accumulating. */
export async function* scanFile(
  roots: WorkspaceRoot[],
  reference: WorkspaceEntry,
  query: string,
  caseSensitive: boolean,
  stats: ScanStats,
  signal: AbortSignal
) {
  const file = await open(roots, reference.rootId, reference.relative);
  try {
    let enc: BufferEncoding = 'utf8',
      doc: string;
    if (path.extname(file.target).toLowerCase() === '.docx') {
      if (file.stat.size > 32 * 1024 * 1024) throw new Error('DOCX 壓縮檔超過 32 MB');
      doc = await extractDocx(file.target);
    } else enc = await encoding(file.handle);
    const decoder = new StringDecoder(enc),
      needle = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    let position = 0,
      decoded = 0,
      line = 1,
      tail = '',
      matched = false;
    const buffer = Buffer.alloc(65536);
    while (true) {
      signal.throwIfAborted();
      let text: string;
      if (doc !== undefined) {
        text = doc.slice(position, position + 32768);
        position += text.length;
      } else {
        const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
        position += bytesRead;
        stats.bytes += bytesRead;
        text = bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
        if (!bytesRead && !text) break;
      }
      if (!text) {
        if (position < file.stat.size && doc === undefined) {
          yield null;
          continue;
        }
        break;
      }
      const pieces = text.split('\n');
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i],
          joined = `${tail}${piece}`;
        const index = caseSensitive ? joined.indexOf(query) : joined.search(needle);
        if (!matched && index >= 0) {
          let start = Math.max(0, index - 120);
          if (start && /[\uDC00-\uDFFF]/.test(joined[start])) start--;
          const snippet = joined.slice(start, Math.max(start + 500, index + query.length));
          const base = decoded - (doc !== undefined ? tail.length : Buffer.byteLength(tail, enc));
          stats.matches++;
          yield {
            ...reference,
            line,
            text: snippet,
            offset:
              base + (doc !== undefined ? start : Buffer.byteLength(joined.slice(0, start), enc)),
            unit: doc !== undefined ? 'characters' : 'bytes',
            version: file.version,
            citation: `[${reference.rootName}/${reference.relative}]`,
          };
          matched = true;
        }
        decoded += doc !== undefined ? piece.length : Buffer.byteLength(piece, enc);
        if (i < pieces.length - 1) {
          line++;
          matched = false;
          tail = '';
          decoded += doc !== undefined ? 1 : Buffer.byteLength('\n', enc);
        } else {
          const length = Math.max(1, query.length - 1);
          tail = joined.slice(-length);
          if (/[\uDC00-\uDFFF]/.test(tail[0])) tail = joined.slice(-length - 1);
        }
      }
      yield null;
    }
    if (versionOf(await file.handle.stat()) !== file.version)
      throw new Error('搜尋期間檔案已變更，結果可能過期；讀取時請帶入 version');
    stats.scannedFiles++;
  } finally {
    await file.handle.close();
  }
}
