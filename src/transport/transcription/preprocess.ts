import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileProgress } from '../../domain/asr/file-progress';
import { type AudioChunk, BYTE_RATE } from './pipeline/boundaries';

export { FILE_CHUNK_SECONDS, FILE_SAMPLE_RATE } from './pipeline/boundaries';

interface Prepared {
  filePath: string;
  chunks: AudioChunk[];
  duration: number;
}

function workerPath() {
  for (let directory = __dirname; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'transport/transcription/pipeline/worker.cjs');
    if (existsSync(candidate)) return candidate;
    if (path.dirname(directory) === directory)
      throw new Error('找不到音訊前處理 Worker，請重新安裝應用程式');
  }
}

/** Heavy DSP and boundary scanning live in a Worker/process; only one upload buffer crosses here. */
export async function* audioChunks(
  filePath: string,
  signal?: AbortSignal,
  {
    denoise = true,
    onProgress,
  }: { denoise?: boolean; onProgress?: (event: FileProgress) => void } = {}
) {
  signal?.throwIfAborted();
  const worker = new Worker(workerPath(), { workerData: { filePath, denoise } });
  let ready = false;
  let resolvePrepared: (value: Prepared) => void;
  let rejectPrepared: (reason: Error) => void;
  const prepared = new Promise<Prepared>((resolve, reject) => {
    resolvePrepared = resolve;
    rejectPrepared = reject;
  });
  worker.on('message', (message) => {
    if (message.type === 'progress' && !signal?.aborted) onProgress?.(message.value);
    if (message.type === 'ready') {
      ready = true;
      resolvePrepared(message.value);
    }
    if (message.type === 'failure')
      rejectPrepared(Object.assign(new Error(message.message), { name: message.name }));
  });
  worker.on('error', rejectPrepared);
  const closed = new Promise<void>((resolve) =>
    worker.once('exit', () => {
      if (!ready) rejectPrepared(new Error('音訊前處理 Worker 已停止'));
      resolve();
    })
  );

  const abort = () => worker.postMessage('cancel');

  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await prepared;
    signal?.throwIfAborted();
    const input = await open(result.filePath, 'r');
    try {
      for (const chunk of result.chunks) {
        signal?.throwIfAborted();
        const length = Math.round((chunk.end - chunk.start) * BYTE_RATE);
        const pcm = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
          const read = await input.read(
            pcm,
            offset,
            length - offset,
            Math.round(chunk.start * BYTE_RATE) + offset
          );
          if (!read.bytesRead) throw new Error('音訊暫存檔讀取不完整');
          offset += read.bytesRead;
        }
        yield { ...chunk, pcm, totalChunks: result.chunks.length, totalSeconds: result.duration };
      }
    } finally {
      await input.close();
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    worker.postMessage('release');
    await closed;
  }
}
