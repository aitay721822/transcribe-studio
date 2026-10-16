import {
  annotationTargets,
  assertAnnotationScope,
  rebaseAnnotations,
} from '../../domain/annotations';
import { markdown } from '../application/annotations/markdown';
import { $, type UiRuntime } from '../application/runtime';
import type { WorkspaceController } from '../application/workspace';
import { createViews } from '../components/views';
import { invalidateUI } from '../layout/roots';
import { Button } from '../primitives/button';
import { referenceDrafts, referenceKey } from './context/mentions/chips';

export function createAgentController(host: UiRuntime, workspace: WorkspaceController) {
  const { state, api, current, updateMeeting, applyInputState, toast, safe, showModal, render } =
    host;
  const { saveNotes } = workspace;
  let submittingAgent = false;

  const agentFeed = () => createViews(state, host.capture).agentFeed();

  async function runAgent(mode: 'queue' | 'steer' = 'queue', marked = false) {
    if (submittingAgent) return;
    submittingAgent = true;
    try {
      await submitAgent(mode, marked);
    } finally {
      submittingAgent = false;
    }
  }

  async function submitAgent(mode: 'queue' | 'steer', marked: boolean) {
    const command = $('#agent-input')?.value.trim();
    if (command?.startsWith('/')) {
      if (!['/compact', '/clear', '/help'].includes(command))
        throw new Error('未知指令，請使用 /compact、/clear 或 /help');
      if (command === '/help') {
        showModal(
          'Agent 指令',
          <div>
            <p>
              <strong>/compact</strong> 將對話與工具結果整理成摘要，供後續對話使用；完整參數與
              output 保留在原始紀錄。摘要可能省略細節，必要時仍可查閱來源。
            </p>
            <p>
              <strong>/clear</strong> 清空目前對話、提案與
              session；保留逐字稿、會議紀錄、音訊和磁碟上的對話原始紀錄。
            </p>
            <p>
              請先停止工作並移除佇列，再使用 /compact 或
              /clear。壓縮會使用目前選定的模型，並計入回合與時間上限。
            </p>
          </div>
        );
        return;
      }
      await saveNotes();
      const id = current().id;
      const result = await api('agent:command', id, command.slice(1));
      if (state.meetingId !== id) return;
      if ('cleared' in result && result.cleared) {
        for (const image of state.imageDrafts?.[id] || [])
          await api('agent:image-release', image.id);
        if (state.imageDrafts) state.imageDrafts[id] = [];
        if (state.annotationDrafts) state.annotationDrafts[id] = [];
        if (state.referenceDrafts) state.referenceDrafts[id] = [];
        state.agentEvents = [];
        state.proposal = null;
        state.runId = null;
        if (state.temporaryChat) state.temporaryChat.chats = [];
        else updateMeeting(await api('meeting:get', id));
      }
      applyInputState(await api('agent:input-state', id));
      $('#agent-input').value = '';
      $('#agent-input').dispatchEvent(new Event('input', { bubbles: true }));
      updateAgentFeed();
      toast(
        'cleared' in result && result.cleared
          ? '目前對話已清空，會議內容與原始紀錄已保留'
          : '開始壓縮上下文'
      );
      return;
    }
    if (host.capture.active && host.capture.id === state.meetingId) {
      toast('請先結束會議，再由 Agent 整理完整紀錄');
      return;
    }
    await saveNotes();
    let m = current();
    const references = referenceDrafts(state, m).map((r) => ({ ...r }));
    const images = (state.imageDrafts?.[m.id] || []).map((image) => ({ ...image }));
    const permission = state.agentMode || 'edit';
    const drafts = (state.annotationDrafts?.[m.id] || []).map((a) => ({ ...a }));
    let annotationIds =
      marked || $('#use-annotations')?.checked
        ? (m.annotations || []).filter((a) => a.status === 'pending').map((a) => a.id)
        : undefined;
    const typed = $('#agent-input').value.trim();

    const defaultInstruction = () => {
      if (drafts.length) {
        if (drafts.every((a) => a.comment.trim())) {
          return '請依引用內容的修改指示修訂 Markdown。';
        }
        return '';
      }
      if (annotationIds) {
        return '請依每則標記的修改指示修訂 Markdown。';
      }
      return '';
    };

    const instruction = typed || defaultInstruction();
    const message = instruction || (images.length ? '請分析附件圖片。' : '');
    if (!message) throw new Error('請輸入訊息或加入圖片');
    if (permission === 'read' && (drafts.length || annotationIds?.length))
      throw new Error('唯讀模式無法編修標記，請先移除引用或改為編修模式');
    if (drafts.length) {
      const targets = drafts.map((a) => {
        if (a.status !== 'pending' || m.notes.slice(a.start, a.end) !== a.quote)
          throw new Error('引用原文已變動，請移除引用後重新選取');
        const comment = typed ? [a.comment, typed].filter(Boolean).join('\n') : a.comment;
        if (comment.length > 4000) throw new Error('每段引用的修改指示最多 4,000 字');
        return { ...a, comment };
      });
      const ids = new Set(targets.map((a) => a.id));
      m = await api(
        'meeting:update',
        m.id,
        { annotations: [...(m.annotations || []).filter((a) => !ids.has(a.id)), ...targets] },
        m.version
      );
      updateMeeting(m);
      annotationIds = targets.map((a) => a.id);
    }
    if (annotationIds) annotationTargets(m.notes, m.annotations || [], annotationIds);
    const editor = $('#notes-editor');

    const selectedText = () => {
      if (drafts.length) {
        return '';
      }
      if (editor) {
        return editor.value.slice(editor.selectionStart, editor.selectionEnd);
      }
      return '';
    };

    const selection = selectedText();
    const skill = $('#skill-select').value;
    if (!state.runId) {
      state.agentEvents = [];
      state.proposal = null;
    }
    const chat = {
      id: crypto.randomUUID(),
      text: message,
      createdAt: new Date().toISOString(),
      references,
      images,
      mode: permission,
    };
    if (state.temporaryChat) state.temporaryChat.chats.push(chat);
    else {
      m.chats.push(chat);
      updateMeeting(
        await api('meeting:update', m.id, {
          chats: m.chats,
        })
      );
    }
    const expectedRunId = state.runId;
    {
      const result = await api(
        'agent:submit',
        {
          meetingId: m.id,
          messageId: chat.id,
          instruction: message,
          selection,
          annotationIds,
          skillIds: skill ? [skill] : [],
          references,
          mode: permission,
          images,
        },
        mode,
        expectedRunId
      );
      if (state.imageDrafts?.[m.id])
        state.imageDrafts[m.id] = state.imageDrafts[m.id].filter(
          (image) => !images.some((sent) => sent.id === image.id)
        );
      if (state.referenceDrafts?.[m.id])
        state.referenceDrafts[m.id] = state.referenceDrafts[m.id].filter(
          (r) => !references.some((sent) => referenceKey(sent) === referenceKey(r))
        );
      if (drafts.length && state.annotationDrafts?.[m.id])
        state.annotationDrafts[m.id] = state.annotationDrafts[m.id].filter(
          (a) => !drafts.some((sent) => JSON.stringify(sent) === JSON.stringify(a))
        );
      if (state.meetingId === m.id) {
        // Read authoritative state: a very fast run may have finished before the IPC reply.
        applyInputState(await api('agent:input-state', m.id));
        if ($('#agent-input')?.value.trim() === typed) {
          $('#agent-input').value = '';
          $('#agent-input').dispatchEvent(new Event('input', { bubbles: true }));
        }
        updateAgentFeed();
        if (mode === 'steer')
          toast(result.disposition === 'steered' ? '已引導目前工作' : '訊息已排入下一輪');
      }
    }
  }

  function updateAgentFeed() {
    const feed = $('#agent-feed');
    const follow = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    invalidateUI();
    requestAnimationFrame(() => {
      const feed = $('#agent-feed');
      if (feed && follow) feed.scrollTop = feed.scrollHeight;
    });
  }

  async function reviewProposal() {
    await saveNotes();
    const p = state.proposal;
    if (!p) return;
    let conflict = current().version !== p.version;
    if (p.annotationScope) {
      try {
        assertAnnotationScope(current().notes, current().annotations || [], p.annotationScope);
      } catch {
        conflict = true;
      }
    }
    const modal = showModal(
      '檢查 Agent 修訂',
      <>
        {conflict ? (
          <div className="notice error">
            生成期間文件或標記已被修改，請重新執行 Agent 後再套用。
          </div>
        ) : (
          ''
        )}
        <div className="diff-grid">
          <div>
            <h3>目前版本</h3>
            <div className="document-preview">
              {markdown(current().notes, undefined, current())}
            </div>
          </div>
          <div>
            <h3>Agent 提案</h3>
            <div className="document-preview">{markdown(p.notes, undefined, current())}</div>
          </div>
        </div>
      </>,
      <>
        <Button
          variant="outline"
          className="btn"
          id="reject-proposal"
          onClick={() => {
            state.proposal = null;
            modal.close();
            updateAgentFeed();
          }}
        >
          捨棄提案
        </Button>
        <Button
          variant="default"
          className="btn primary"
          id="accept-proposal"
          disabled={conflict}
          onClick={safe(async () => {
            await saveNotes();
            const m = await api(
              'meeting:update',
              state.meetingId,
              {
                notes: p.notes,
                annotations: rebaseAnnotations(
                  current().annotations || [],
                  current().notes,
                  p.notes
                ).map((a) =>
                  p.annotationIds?.includes(a.id) ? { ...a, status: 'resolved' as const } : a
                ),
              },
              p.version,
              p.annotationScope
            );
            updateMeeting(m);
            state.dirty = false;
            state.proposal = null;
            modal.close();
            render();
            toast('修訂已套用，原稿已保留在版本歷史');
          })}
        >
          套用修訂
        </Button>
      </>
    );
  }

  return {
    runAgent,
    updateAgentFeed,
    reviewProposal,
  };
}

export type AgentController = ReturnType<typeof createAgentController>;
