import fsp from 'node:fs/promises';
import { dialog } from 'electron';
import { exportDocx } from '../../services/documents/export-docx';
import { removeMeeting } from '../../services/meetings/lifecycle';
import type { DesktopContext } from '../context';

export function registerMeetings(ctx: DesktopContext) {
  const { handle, win, store, meeting, sanitizeMeeting } = ctx;
  handle('meeting:create', (id, title, source) =>
    sanitizeMeeting(store.createMeeting(id, title, source))
  );
  handle('meeting:get', (id) => sanitizeMeeting(meeting(id)));
  handle('meeting:delete', async (id) => {
    const ensureIdle = () => {
      meeting(id);
      if (
        [...ctx.recordings.values()].some((r) => r.meetingId === id) ||
        ctx.agent.isRunningMeeting(id) ||
        ctx.asr.has(id) ||
        ctx.rtcCaches.has(id)
      )
        throw new Error('請先結束此會議的錄音、辨識與 Agent 工作');
    };

    ensureIdle();
    try {
      await ctx.asrTasks.prepareDeletion(id);
      return await removeMeeting(store, ctx.dataDir, id, ensureIdle);
    } finally {
      ctx.asrTasks.endDeletion(id);
    }
  });
  handle('meeting:update', (id, patch, version, annotationScope) => {
    if ('agentSessions' in patch || 'agentHistory' in patch)
      throw new Error('Agent session 由 harness 管理');
    if (patch.notes != null && (typeof patch.notes !== 'string' || patch.notes.length > 1000000))
      throw new Error('文件內容過大');
    return sanitizeMeeting(store.updateMeeting(id, patch, version, annotationScope));
  });
  handle('meeting:revisions', (id) => store.revisionList(id));
  handle('export:docx', async (id, transcript) => {
    const m = meeting(id);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `${m.title.replace(/[<>:"/\\|?*]/g, '_')}.docx`,
      filters: [{ name: 'Word 文件', extensions: ['docx'] }],
    });
    if (result.canceled) return null;
    await fsp.writeFile(result.filePath, await exportDocx(m, transcript));
    return result.filePath;
  });
}
