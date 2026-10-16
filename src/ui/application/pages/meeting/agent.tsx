import { toolCallTraces } from '../../../../domain/agents/trace';
import { SentReferences } from '../../../agent/context/mentions/chips';
import { CompactionStatus } from '../../../agent/context/status';
import { AgentExecution } from '../../../agent/execution';
import { imageUrl } from '../../../agent/session/images';
import { ToolTrace } from '../../../agent/trace';
import { btn, date, markdown } from '../../../components/display';
import { icon } from '../../../components/icons';
import { Button } from '../../../primitives/button';
import type { PageContext } from '../contracts';

export function agentViews(context: PageContext) {
  const { state, capture, project, current } = context;

  function agentFeed() {
    const m = current();
    if (!m) return '';
    const calls = toolCallTraces(state.agentEvents);
    const callByInput = new Map(calls.map((call) => [call.input, call]));
    const compacted = new Map(
      state.agentEvents.filter((e) => e.type === 'compaction' && e.callId).map((e) => [e.callId, e])
    );
    return (
      <>
        {(state.temporaryChat?.chats || m.chats)
          .filter((c) => !c.id || !state.agentQueue?.some((q) => q.messageId === c.id))
          .filter(
            (c) =>
              !c.id ||
              (!state.discardedChatIds?.includes(c.id) &&
                !m.agentHistory?.some(
                  (run) => run.messageId === c.id && run.status === 'cancelled' && !run.started
                ))
          )
          .map((c, __index) => (
            <div className="chat-user" key={__index}>
              {c.text}
              {c.images?.length ? (
                <div className="chat-images">
                  {c.images.map((image) => (
                    <img key={image.id} src={imageUrl(m.id, image)} alt={image.name} />
                  ))}
                </div>
              ) : null}
              <SentReferences references={c.references} />
            </div>
          ))}
        {(state.temporaryChat ? [] : m.agentHistory || [])
          .filter((r) => r.notes)
          .slice(-3)
          .map((r, __index) => (
            <details className="proposal-card" key={r.runId}>
              <summary>先前的修訂提案 · {date(r.createdAt)}</summary>
              <div className="document-preview">{markdown(r.notes, undefined, m)}</div>
            </details>
          ))}

        <AgentExecution state={state} />
        {!state.temporaryChat &&
          (m.agentHistory || [])
            .filter(
              (r) =>
                r.answer &&
                !state.agentEvents.some((e) => e.runId === r.runId && e.type === 'answer')
            )
            .map((r) => (
              <div className="chat-assistant document-preview" key={r.runId}>
                {markdown(r.answer, undefined, m)}
              </div>
            ))}
        {state.agentEvents.map((e, __index) => {
          if (e.type === 'answer')
            return (
              <div className="chat-assistant document-preview" key={e.id || __index}>
                {markdown(e.message, undefined, m)}
              </div>
            );
          if (e.type === 'compaction')
            return !e.callId || compacted.get(e.callId) === e ? (
              <CompactionStatus key={e.callId || e.id || __index} event={e} />
            ) : null;
          if (e.type === 'tool') {
            const call = callByInput.get(e);
            return (
              <ToolTrace
                key={call.key}
                call={call}
                running={!!state.runId && (!call.input.runId || call.input.runId === state.runId)}
              />
            );
          }
          if (e.type === 'approval')
            return (
              <div className="approval-card" key={e.id || __index}>
                <strong>工具需要你的確認</strong>
                <p>{e.name}</p>
                <pre>{JSON.stringify(e.args, null, 2)}</pre>
                <div className="button-row">
                  <Button
                    variant="default"
                    size="sm"
                    className="btn primary small"
                    data-approval={e.id}
                    data-answer="yes"
                  >
                    允許這次執行
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="btn small"
                    data-approval={e.id}
                    data-answer="no"
                  >
                    拒絕
                  </Button>
                </div>
              </div>
            );
          if (['log', 'error', 'steered'].includes(e.type))
            return (
              <div
                className={`agent-log ${e.type === 'error' ? 'error' : ''}`}
                key={e.id || __index}
              >
                {icon(e.type === 'tool' ? 'search' : 'sparkle')}
                <span>{e.message || e.name}</span>
              </div>
            );
          return '';
        })}

        {state.proposal ? (
          <div className="proposal-card">
            <strong>修訂已準備完成</strong>
            <p>先查看修改內容，再選擇是否套用。</p>
            {btn('檢視修訂', 'review-proposal', 'file', 'small primary')}
          </div>
        ) : (
          ''
        )}
      </>
    );
  }

  return {
    agentFeed,
  };
}
