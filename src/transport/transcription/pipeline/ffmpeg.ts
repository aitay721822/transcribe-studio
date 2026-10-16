import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { stopChild } from '../../runtime/process';

/** FFmpeg performs DSP outside both Electron's renderer and main thread. */
export async function runFfmpeg(
  args: string[],
  signal: AbortSignal,
  progress: (seconds: number) => void
) {
  signal.throwIfAborted();
  if (!ffmpegPath) throw new Error('此平台無法執行音訊前處理');
  const executable = ffmpegPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const child = spawn(
    executable,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-threads',
      '1',
      '-filter_threads',
      '1',
      '-progress',
      'pipe:1',
      '-stats_period',
      '0.25',
      ...args,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  let processError: Error | undefined;
  child.on('error', (error) => {
    processError = error;
  });
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

  const abort = () => {
    void stopChild(child, { group: false });
  };

  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let pending = '';
  try {
    for await (const bytes of child.stdout) {
      pending = `${pending}${bytes.toString()}`;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) progress(Number(match[1]) / 1000000);
      }
    }
    const code = await closed;
    signal.throwIfAborted();
    if (processError) throw new Error('無法啟動音訊前處理，請重新安裝應用程式');
    if (code !== 0) throw new Error('音訊前處理失敗，請確認檔案完整且包含音訊，並檢查暫存磁碟空間');
  } finally {
    signal.removeEventListener('abort', abort);
    if (child.exitCode === null && child.signalCode === null)
      await stopChild(child, { group: false });
    await closed;
  }
}
