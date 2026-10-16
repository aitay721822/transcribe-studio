import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { FileProgress } from '../../../domain/asr/file-progress';
import { BYTE_RATE, FILE_SAMPLE_RATE, segmentAudio } from './boundaries';
import { runFfmpeg } from './ffmpeg';

const controller = new AbortController();
let release: () => void;
const released = new Promise<void>((resolve) => {
  release = resolve;
});
parentPort.on('message', (message) => {
  if (message === 'cancel') controller.abort();
  release();
});
let lastStage = '';
let lastSent = 0;

function progress(event: FileProgress) {
  const now = Date.now();
  if (event.stage !== lastStage || event.percent === 100 || now - lastSent >= 250) {
    lastStage = event.stage;
    lastSent = now;
    parentPort.postMessage({ type: 'progress', value: event });
  }
}

async function run() {
  let directory: string;
  try {
    const resolved = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'studio-audio-work-')));
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('studio-audio-work-')
    )
      throw new Error('音訊暫存目錄超出清理範圍');
    directory = resolved;
    const decoded = path.join(directory, 'decoded.pcm');
    progress({ stage: 'decode', seconds: 0 });
    await runFfmpeg(
      [
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        path.resolve(workerData.filePath),
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(FILE_SAMPLE_RATE),
        '-acodec',
        'pcm_s16le',
        '-f',
        's16le',
        decoded,
      ],
      controller.signal,
      (seconds) => progress({ stage: 'decode', seconds })
    );
    const duration = (await stat(decoded)).size / BYTE_RATE;
    if (!duration) throw new Error('音訊檔案沒有可辨識的音訊');
    progress({ stage: 'decode', percent: 100, seconds: duration, totalSeconds: duration });
    let prepared = decoded;
    progress({
      stage: 'denoise',
      percent: 0,
      seconds: 0,
      denoise: workerData.denoise,
      totalSeconds: duration,
    });
    if (workerData.denoise) {
      prepared = path.join(directory, 'denoised.pcm');
      await runFfmpeg(
        [
          '-f',
          's16le',
          '-ar',
          String(FILE_SAMPLE_RATE),
          '-ac',
          '1',
          '-i',
          decoded,
          '-af',
          'highpass=f=70,afftdn=nr=8:nf=-45:tn=1:gs=5',
          '-acodec',
          'pcm_s16le',
          '-f',
          's16le',
          prepared,
        ],
        controller.signal,
        (seconds) =>
          progress({
            stage: 'denoise',
            percent: Math.min(99, (seconds / duration) * 100),
            seconds,
            totalSeconds: duration,
            denoise: true,
          })
      );
      if ((await stat(prepared)).size !== (await stat(decoded)).size)
        throw new Error('降噪後音訊長度不一致，已停止辨識以保護時間標記');
      await rm(decoded);
    }
    progress({
      stage: 'denoise',
      percent: 100,
      denoise: workerData.denoise,
      seconds: duration,
      totalSeconds: duration,
    });
    progress({ stage: 'segment', percent: 0, seconds: 0, totalSeconds: duration });
    const result = await segmentAudio(prepared, controller.signal, (seconds, totalSeconds) =>
      progress({
        stage: 'segment',
        percent: Math.min(99, (seconds / totalSeconds) * 100),
        seconds,
        totalSeconds,
      })
    );
    controller.signal.throwIfAborted();
    progress({
      stage: 'segment',
      percent: 100,
      seconds: duration,
      totalChunks: result.chunks.length,
      totalSeconds: duration,
    });
    parentPort.postMessage({ type: 'ready', value: { ...result, filePath: prepared } });
    await released;
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

    parentPort.postMessage({ type: 'failure', message: error.message, name: error.name });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    parentPort.close();
  }
}

void run();
