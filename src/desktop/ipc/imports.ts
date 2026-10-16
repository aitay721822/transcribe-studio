import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dialog } from 'electron';
import { z } from 'zod';
import { replacementRange } from '../../domain/asr/range';
import { validateAudioFileSize } from '../../domain/transcription';
import { parseTranscript } from '../../services/meetings/transcript';
import type { DesktopContext } from '../context';

export function registerImports(ctx: DesktopContext) {
  const { handle, win, store, imports, meeting, sanitizeMeeting, send, asrTasks } = ctx;
  handle('file:pick', async (kind) => {
    const result = await dialog.showOpenDialog(win, {
      title: '匯入音訊或逐字稿',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: kind === 'audio' ? '音訊檔案' : '音訊與逐字稿',
          extensions:
            kind === 'audio'
              ? ['wav', 'mp3', 'm4a', 'flac', 'webm', 'ogg']
              : ['wav', 'mp3', 'm4a', 'flac', 'webm', 'ogg', 'txt', 'srt', 'vtt'],
        },
      ],
    });
    return result.filePaths.map((file) => {
      const id = randomUUID();
      imports.set(id, file);
      return { id, name: path.basename(file), size: fs.statSync(file).size };
    });
  });
  handle('file:transcribe', async (projectId, fileId, options) => {
    const file = imports.get(fileId);
    if (!file) throw new Error('請重新選擇檔案');
    imports.delete(fileId);
    const stat = await fsp.stat(file);
    const transcript = ['.txt', '.srt', '.vtt'].includes(path.extname(file).toLowerCase());
    if (transcript && stat.size > 25 * 1024 * 1024) throw new Error('單檔逐字稿上限 25 MB');
    if (!transcript) validateAudioFileSize(stat.size);
    const m = store.createMeeting(projectId, path.basename(file, path.extname(file)), 'file');
    try {
      if (transcript) {
        const text = await fsp.readFile(file, 'utf8');
        if (!text) throw new Error('沒有辨識到文字');
        for (const segment of parseTranscript(text)) store.segment(m.id, segment);
        store.updateMeeting(m.id, { status: 'completed' });
      } else {
        const rid = randomUUID();
        const target = path.join(ctx.dataDir, 'audio', `${rid}${path.extname(file).toLowerCase()}`);
        await fsp.copyFile(file, target, fs.constants.COPYFILE_EXCL);
        const fd = await fsp.open(target, 'r+');
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
        store.recording(m.id, {
          id: rid,
          path: target,
          complete: true,
          bytes: stat.size,
          offset: 0,
          startedAt: new Date().toISOString(),
        });
        store.updateMeeting(m.id, { status: 'transcribing' });
        asrTasks.createFile({
          meetingId: m.id,
          recordingId: rid,
          file: target,
          source: 'import',
          denoise: options?.denoise,
        });
      }
      const current = sanitizeMeeting(meeting(m.id));
      send('meeting:event', current);
      return current;
    } catch (error) {
      store.updateMeeting(m.id, { status: 'failed' });
      send('meeting:event', sanitizeMeeting(meeting(m.id)));
      throw error;
    }
  });
  handle('recording:transcribe', (id, rid, options) => {
    const draft = z
      .object({
        denoise: z.boolean().optional(),
        start: z.number().finite().min(0).optional(),
        end: z.number().finite().min(0).optional(),
        replace: z.boolean().optional(),
      })
      .strict()
      .parse(options || {});
    const m = meeting(id);
    const recording = m.recordings.find((item) => item.id === rid);
    if (!recording?.path) throw new Error('找不到此錄音檔案');
    if ([...ctx.recordings.values()].some((item) => item.id === rid))
      throw new Error('請先結束目前的錄音');
    if (m.status === 'recording') throw new Error('請先結束目前的錄音');
    const duplicate = asrTasks.repository.db
      .prepare(`SELECT id FROM asr_tasks WHERE meeting_id=? AND deleted=0
      AND json_extract(data,'$.recordingId')=? AND state NOT IN ('completed','cancelled','needs_attention') LIMIT 1`)
      .get(id, rid);
    if (duplicate) throw new Error('此錄音已有辨識任務，請先至辨識任務面板管理');
    const start = draft.start ?? 0;
    const end =
      draft.end ?? recording.duration ?? Math.max(0, m.duration - (recording.offset || 0));
    const range = replacementRange(
      m.segments,
      rid,
      recording.offset || 0,
      start,
      end || Number.POSITIVE_INFINITY
    );
    if (range.segments.length && !draft.replace) throw new Error('請先確認要替換的逐字稿範圍');
    if (range.segments.length && (range.start !== start || (end && range.end !== end)))
      throw new Error('請擴展至完整逐字稿分段範圍');
    asrTasks.createFile({
      meetingId: id,
      recordingId: rid,
      file: recording.path,
      source: 'recording',
      denoise: draft.denoise,
      start: draft.start,
      end: draft.end,
      replace: draft.replace,
    });
    return Promise.resolve(sanitizeMeeting(meeting(id)));
  });
  return { close: async () => {} };
}
