import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AsrFailure } from '../../domain/asr/retry';
import { type AsrChunk, chunkSchema } from '../../domain/asr/tasks';

const resultSchema = z.object({
  chunkId: z.string(),
  generation: z.number().int(),
  lease: z.string(),
  text: z.string(),
});
export type SavedResult = z.infer<typeof resultSchema>;

export class AudioSpool {
  readonly root: string;

  constructor(
    root: string,
    readonly maxBytes = 2 * 1024 ** 3,
    readonly minimumFree = 1024 ** 3
  ) {
    this.root = path.resolve(root);
  }

  private directory(taskId: string): string {
    if (!/^[\w-]{1,100}$/.test(taskId)) throw new Error('無效的辨識任務路徑');
    return path.join(this.root, taskId);
  }

  private checked(file: string): string {
    const resolved = path.resolve(file);
    const relative = path.relative(this.root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('辨識暫存檔超出允許範圍');
    return resolved;
  }

  private async atomic(file: string, data: Uint8Array | string): Promise<void> {
    const target = this.checked(file);
    await mkdir(path.dirname(target), { recursive: true });
    await this.owned(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const fd = await open(temporary, 'wx');
    try {
      await fd.writeFile(data);
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async capacity(pendingBytes: number, incoming = 0): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root);
    if (
      pendingBytes + incoming > this.maxBytes ||
      disk.bavail * disk.bsize - incoming < this.minimumFree
    )
      throw new AsrFailure({
        kind: 'audio',
        scope: 'none',
        message:
          '補辨識暫存空間不足，已暫停新增分段；請釋放空間或刪除不需要的任務，原始錄音仍獨立保存',
      });
  }

  private async owned(file: string): Promise<string> {
    const target = this.checked(file);
    const canonicalRoot = await realpath(this.root);
    const parent = await realpath(path.dirname(target));
    const expected = path.join(canonicalRoot, path.relative(this.root, path.dirname(target)));
    if (parent !== expected) throw new Error('辨識暫存路徑不可指向其他目錄');
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('辨識暫存檔不可為連結或目錄');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
        throw error;
    }
    return target;
  }

  async put(
    taskId: string,
    index: number,
    start: number,
    end: number,
    bytes: Uint8Array,
    generation: number,
    overlap = false
  ): Promise<AsrChunk> {
    const id = createHash('sha256').update(`${taskId}:${index}`).digest('hex');
    const file = path.join(this.directory(taskId), `${id}.wav`);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const existing = await this.manifest(`${file}.json`);
    if (existing) {
      if (existing.checksum !== checksum || existing.start !== start || existing.end !== end)
        throw new Error('辨識分段與既有音訊不一致，已保留原始分段');
      await this.bytes(existing);
      return existing;
    }
    const chunk: AsrChunk = {
      id,
      taskId,
      index,
      start,
      end,
      path: file,
      bytes: bytes.byteLength,
      checksum,
      state: 'queued',
      attempts: 0,
      failures: 0,
      generation,
      lease: '',
      overlap,
    };
    await this.atomic(file, bytes);
    await this.atomic(`${file}.json`, JSON.stringify(chunk));
    return chunk;
  }

  async manifest(file: string): Promise<AsrChunk | undefined> {
    try {
      const chunk = chunkSchema.parse(JSON.parse(await readFile(await this.owned(file), 'utf8')));
      this.checked(chunk.path);
      if (path.dirname(chunk.path) !== this.directory(chunk.taskId))
        throw new Error('辨識分段路徑與任務不符');
      return chunk;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    }
  }

  async bytes(chunk: AsrChunk): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await readFile(await this.owned(chunk.path));
    } catch {
      throw new AsrFailure({
        kind: 'audio',
        scope: 'none',
        message: '辨識分段無法讀取，請由原始錄音重新建立任務',
      });
    }
    if (
      bytes.byteLength !== chunk.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== chunk.checksum
    )
      throw new AsrFailure({
        kind: 'audio',
        scope: 'none',
        message: '辨識分段校驗失敗，請使用原始錄音重新建立任務',
      });
    return bytes;
  }

  async saveResult(chunk: AsrChunk, text: string): Promise<void> {
    await this.atomic(
      `${this.checked(chunk.path)}.result.json`,
      JSON.stringify({
        chunkId: chunk.id,
        generation: chunk.generation,
        lease: chunk.lease,
        text,
      })
    );
  }

  async result(chunk: AsrChunk): Promise<SavedResult | undefined> {
    try {
      const result = resultSchema.parse(
        JSON.parse(
          await readFile(await this.owned(`${this.checked(chunk.path)}.result.json`), 'utf8')
        )
      );
      if (result.chunkId !== chunk.id) throw new Error('辨識結果與分段不符');
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw new AsrFailure({
        kind: 'audio',
        scope: 'none',
        message: '已保存的辨識結果無法驗證，請核對原文後重新建立任務',
      });
    }
  }

  async *manifests(corrupt?: (taskId: string) => void): AsyncGenerator<AsrChunk> {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w-]{1,100}$/.test(entry.name)) continue;
      const directory = this.directory(entry.name);
      for (const file of await readdir(directory)) {
        if (!file.endsWith('.wav.json')) continue;
        try {
          const chunk = await this.manifest(path.join(directory, file));
          if (chunk) yield chunk;
        } catch (error) {
          if (!corrupt) throw error;
          corrupt(entry.name);
        }
      }
    }
  }

  async cleanOrphans(referenced: (file: string) => boolean): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w-]{1,100}$/.test(entry.name)) continue;
      const directory = this.directory(entry.name);
      const files = await readdir(directory);
      for (const name of files) {
        const file = path.join(directory, name);
        const orphan =
          name.endsWith('.wav') && !files.includes(`${name}.json`) && !referenced(file);
        const audio = file.replace(/\.result\.json$/, '');
        const orphanResult =
          name.endsWith('.wav.result.json') &&
          !files.includes(`${path.basename(audio)}.json`) &&
          !referenced(audio);
        if (name.endsWith('.tmp') || orphan || orphanResult)
          await rm(await this.owned(file), { force: true });
      }
    }
  }

  async removeChunk(chunk: AsrChunk): Promise<void> {
    const file = this.checked(chunk.path);
    if (path.dirname(file) !== this.directory(chunk.taskId))
      throw new Error('辨識分段路徑與任務不符');
    for (const target of [file, `${file}.json`, `${file}.result.json`]) {
      try {
        await rm(await this.owned(target), { force: true });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
          throw error;
      }
    }
  }

  async removeTask(taskId: string): Promise<void> {
    const directory = this.checked(this.directory(taskId));
    try {
      const canonicalRoot = await realpath(this.root);
      if ((await realpath(directory)) !== path.join(canonicalRoot, taskId))
        throw new Error('辨識暫存路徑不可指向其他目錄');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
