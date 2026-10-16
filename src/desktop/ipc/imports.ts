import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dialog } from 'electron';
import { type AudioJob, audioJobActive, type FileProgress } from '../../domain/asr/file-progress';
import type { Meeting } from '../../domain/models';
import { validateAudioFileSize } from '../../domain/transcription';
import { parseTranscript } from '../../services/meetings/transcript';
import type { FileOptions } from '../../transport/transcription/file';
import { transcribeFile } from '../../transport/transcription/file';
import type { DesktopContext } from '../context';

export function registerImports(ctx: DesktopContext) {
  const { handle, win, store, imports, meeting, sanitizeMeeting, settingsInternal, send } = ctx;
  const jobs = new Map<string, AudioJob>();
  const running = new Map<string, { controller: AbortController; done: Promise<string> }>();
  handle('audio:jobs', () => [...jobs.values()]);
  handle('audio:cancel', (id) => running.get(id)?.controller.abort());

  function processFile(
    m: Meeting,
    file: string,
    options: { denoise?: boolean },
    callbacks: FileOptions
  ) {
    const id = randomUUID();
    const controller = new AbortController();
    const denoise = options?.denoise !== false;
    const base = { id, meetingId: m.id, projectId: m.projectId, title: m.title, denoise };

    const emit = (progress: FileProgress) => {
      const job = { ...jobs.get(id), ...base, ...progress };
      if (audioJobActive(progress)) job.lastStage = progress.stage as AudioJob['lastStage'];
      jobs.set(id, job);
      send('audio:progress', job);
    };

    emit({ stage: 'decode', seconds: 0 });
    const done = transcribeFile(settingsInternal().asr, file, {
      ...callbacks,
      denoise,
      signal: controller.signal,
      onProgress: emit,
    })
      .catch((error) => {
        emit({
          stage: controller.signal.aborted ? 'cancelled' : 'failed',
          message: controller.signal.aborted ? '已取消處理' : error.message,
        });
        throw error;
      })
      .finally(() => {
        running.delete(id);
        for (const [key, job] of jobs) {
          if (jobs.size <= 20) break;
          if (!audioJobActive(job)) jobs.delete(key);
        }
      });
    running.set(id, { controller, done });
    return done;
  }

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
    if (transcript) {
      if (stat.size > 25 * 1024 * 1024) throw new Error('單檔逐字稿上限 25 MB');
    } else validateAudioFileSize(stat.size);
    const m = store.createMeeting(projectId, path.basename(file, path.extname(file)), 'file');
    store.updateMeeting(m.id, { status: 'transcribing' });
    send('meeting:event', sanitizeMeeting(meeting(m.id)));
    try {
      let text;
      if (transcript) {
        text = await fsp.readFile(file, 'utf8');
        if (!text) throw new Error('沒有辨識到文字');
        for (const seg of parseTranscript(text)) store.segment(m.id, seg);
      } else {
        text = await processFile(m, file, options, {
          onSegment: (segment) =>
            store.segment(m.id, {
              ...segment,
              id: randomUUID(),
              final: true,
              speaker: '',
              timing: 'approximate',
            }),

          onDuration: (duration) => {
            store.updateMeeting(m.id, { duration });
            send('meeting:event', sanitizeMeeting(meeting(m.id)));
          },
        });
      }
      if (!text) throw new Error('沒有辨識到文字');
      return sanitizeMeeting(store.updateMeeting(m.id, { status: 'completed' }));
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      store.updateMeeting(m.id, { status: 'failed' });
      send('meeting:event', sanitizeMeeting(meeting(m.id)));
      throw e;
    }
  });
  handle('recording:transcribe', async (id, rid, options) => {
    const m = meeting(id);
    const r = m.recordings.find((r) => r.id === rid);
    if (!r?.complete) throw new Error('此錄音尚未完成');
    if (['recording', 'transcribing'].includes(m.status))
      throw new Error('請先結束目前的錄音或辨識');
    const status = m.status;
    store.updateMeeting(id, { status: 'transcribing' });
    send('meeting:event', sanitizeMeeting(meeting(id)));
    try {
      const segments: { text: string; start: number; end: number }[] = [];
      const text = await processFile(m, r.path, options, {
        filename: 'recording.webm',

        onSegment: (segment) => segments.push(segment),
      });
      if (!text) throw new Error('沒有辨識到文字');
      for (const segment of segments)
        store.segment(id, {
          ...segment,
          id: randomUUID(),
          start: (r.offset || 0) + segment.start,
          end: (r.offset || 0) + segment.end,
          recordingId: rid,
          final: true,
          speaker: '會後補辨識',
          timing: 'approximate',
        });
    } finally {
      store.updateMeeting(id, { status });
      send('meeting:event', sanitizeMeeting(meeting(id)));
    }
    return sanitizeMeeting(meeting(id));
  });
  return {
    close: async () => {
      const active = [...running.values()];
      active.forEach(({ controller }) => controller.abort());
      await Promise.allSettled(active.map(({ done }) => done));
    },
  };
}
