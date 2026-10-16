import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { DesktopContext } from '../../context';

const deviceList = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    isDefault: z.boolean(),
    muted: z.boolean(),
    volume: z.number().min(0).max(1),
  })
);
const packet = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), sampleRate: z.number().int().min(8000).max(192000) }),
  z.object({ type: z.literal('audio'), samples: z.string().max(2000000) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export function registerPlayback(ctx: DesktopContext) {
  const executable = path
    .join(__dirname, 'native', 'studio-loopback.exe')
    .replace(/\.asar([\\/])/g, '.asar.unpacked$1');
  const sessions = new Map<string, () => void>();
  let generation = 0;

  async function devices() {
    if (process.platform !== 'win32') return [];
    const { stdout } = await promisify(execFile)(executable, ['list'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return deviceList.parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
  }

  ctx.handle('media:playback-devices', devices);
  ctx.handle('media:playback-stop', (id) => sessions.get(id)?.());
  ctx.handle('media:playback-start', async (id, deviceId) => {
    const currentGeneration = generation;
    if (process.platform !== 'win32') throw new Error('此平台尚未支援指定播放裝置擷取');
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || typeof deviceId !== 'string')
      throw new Error('無效的音訊擷取要求');
    if (sessions.size) throw new Error('播放裝置正在擷取中，請先結束目前的測試或錄音');
    if (deviceId && !(await devices()).some((device) => device.id === deviceId))
      throw new Error('所選播放裝置已離線，請重新選擇');
    if (generation !== currentGeneration) throw new Error('播放裝置擷取已取消');
    if (sessions.size) throw new Error('播放裝置正在擷取中，請先結束目前的測試或錄音');
    return new Promise<{ sampleRate: number }>((resolve, reject) => {
      const child = spawn(executable, ['capture', deviceId], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let ready = false;
      let stopped = false;
      const lines = createInterface({ input: child.stdout });

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        sessions.delete(id);
        lines.close();
        child.kill();
        reject(new Error('播放裝置擷取已取消'));
      };

      const fail = (message: string) => {
        if (stopped) return;
        if (ready) ctx.send('media:playback', { id, type: 'error', message });
        reject(new Error(message));
        stop();
      };

      const timer = setTimeout(() => fail('播放裝置開啟逾時，請重新選擇裝置'), 10000);
      sessions.set(id, stop);
      child.on('error', (error) => fail(error.message));
      child.on('exit', () => fail('播放裝置擷取已中斷，請確認裝置連線'));
      lines.on('line', (line) => {
        if (stopped) return;
        try {
          const value = packet.parse(JSON.parse(line.replace(/^\uFEFF/, '')));
          if (value.type === 'error') fail(value.message);
          else if (value.type === 'ready') {
            ready = true;
            clearTimeout(timer);
            resolve({ sampleRate: value.sampleRate });
          } else if (ready) {
            const samples = Buffer.from(value.samples, 'base64');
            if (samples.length % 4) throw new Error('播放裝置回傳無效的音訊資料');
            ctx.send('media:playback', { id, type: 'audio', samples });
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : '播放裝置音訊資料無效');
        }
      });
    });
  });

  const stopAll = () => {
    generation++;
    for (const stop of sessions.values()) stop();
  };

  ctx.win.webContents.on('did-start-loading', stopAll);
  ctx.win.webContents.on('render-process-gone', stopAll);
  ctx.win.on('closed', stopAll);
}
