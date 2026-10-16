import fs from 'node:fs';
import type { DesktopContext } from '../context';

/** A renderer reload ends capture, while persisted background work remains owned by main. */
export function registerCaptureLifecycle(ctx: DesktopContext): void {
  const interrupt = () => {
    const sessions = [...ctx.asr.values()];
    ctx.asr.clear();
    ctx.rtcCaches.clear();
    for (const session of sessions) {
      session.ws?.terminate();
      void session.close().catch(() => {});
    }
    for (const [id, recording] of ctx.recordings) {
      try {
        fs.fsyncSync(recording.fd);
      } catch {
        ctx.send('asr:event', {
          meetingId: recording.meetingId,
          type: 'warning',
          message: '錄音同步至磁碟失敗，已保留可讀取的部分，請釋放空間後檢查原始錄音',
        });
      } finally {
        fs.closeSync(recording.fd);
        ctx.recordings.delete(id);
      }
      const meeting = ctx.store.get('meetings', recording.meetingId);
      if (!meeting) continue;
      const saved = meeting.recordings.find((value) => value.id === id);
      if (saved) saved.bytes = recording.bytes;
      meeting.status = 'interrupted';
      ctx.store.putMeeting(meeting);
    }
  };

  ctx.win.webContents.on('did-start-loading', interrupt);
  ctx.win.webContents.on('render-process-gone', interrupt);
}
