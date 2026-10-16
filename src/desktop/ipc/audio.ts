import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from '../context';

export function registerAudio(ctx: DesktopContext) {
  const { handle, store, dataDir, recordings, meeting, sanitizeMeeting } = ctx;
  handle('audio:start', async (id) => {
    const m = meeting(id);
    if (m.status === 'transcribing') throw new Error('請先完成或取消此會議的音訊辨識');
    if ([...recordings.values()].some((r) => r.meetingId === id)) throw new Error('此會議已在錄音');
    const rid = randomUUID();
    const file = path.join(dataDir, 'audio', `${rid}.webm`);
    const fd = fs.openSync(file, 'wx');
    const r = {
      id: rid,
      meetingId: id,
      fd,
      path: file,
      bytes: 0,
      startedAt: new Date().toISOString(),
      offset: m.duration || 0,
    };
    recordings.set(rid, r);
    store.recording(id, {
      id: rid,
      path: file,
      startedAt: r.startedAt,
      offset: r.offset,
      complete: false,
    });
    store.updateMeeting(id, { status: 'recording' });
    return rid;
  });
  handle('audio:chunk', (rid, bytes) => {
    const r = recordings.get(rid);
    if (!r) throw new Error('錄音工作階段已結束');
    const b = Buffer.from(bytes);
    if (b.length > 8 * 1024 * 1024) throw new Error('音訊片段過大');
    let written = 0;
    while (written < b.length) {
      const size = fs.writeSync(r.fd, b, written, b.length - written);
      if (!size) throw new Error('錄音檔案無法繼續寫入');
      written += size;
      r.bytes += size;
    }
    return r.bytes;
  });
  handle('audio:finish', (rid, duration, interrupted = false) => {
    if (!Number.isFinite(duration) || duration < 0) throw new Error('錄音時間無效');
    const r = recordings.get(rid);
    if (!r) throw new Error('找不到錄音工作階段');
    let flushed = true;
    try {
      fs.fsyncSync(r.fd);
    } catch {
      flushed = false;
    } finally {
      fs.closeSync(r.fd);
      recordings.delete(rid);
    }
    const m = meeting(r.meetingId);
    const record = m.recordings.find((a) => a.id === rid);
    record.complete = flushed && !interrupted;
    record.bytes = r.bytes;
    record.duration = duration;
    store.putMeeting(m);
    return sanitizeMeeting(
      store.updateMeeting(m.id, {
        duration: r.offset + duration,
        status: record.complete ? 'completed' : 'interrupted',
      })
    );
  });
}
