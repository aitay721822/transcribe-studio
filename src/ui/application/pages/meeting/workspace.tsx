import { queueView } from '../../../agent/composer';
import { AgentInput } from '../../../agent/context/input';
import { AudioJobs } from '../../../audio/processing/progress';
import { badge, btn } from '../../../components/display';
import { icon } from '../../../components/icons';
import { WorkspacePanels } from '../../../layout/workspace';
import { Button } from '../../../primitives/button';
import { NotesPane } from '../../annotations/editor';
import type { PageContext } from '../contracts';
import { agentViews } from './agent';
import { sourceViews } from './source';
import { RecordTimer } from './status';

export function workspaceViews(context: PageContext) {
  const { state, capture, current } = context;
  const { sourceBody } = sourceViews(context);
  const { agentFeed } = agentViews(context);

  function workspacePage() {
    const m = current();
    if (!m) return <div className="content">找不到會議</div>;
    const active = capture.active && capture.id === m.id;

    const recordingControls = () => {
      if (active) {
        return (
          <>
            {btn(
              capture.paused ? '繼續' : '暫停',
              'pause-recording',
              capture.paused ? 'play' : 'pause',
              'small'
            )}
            {btn('結束會議', 'stop-recording', 'stop', 'small danger')}

            {btn('標記重點', 'add-marker', 'pin', 'small')}
          </>
        );
      }
      if (m.source === 'live' && m.status !== 'transcribing') {
        return btn('繼續錄音', 'start-recording', 'mic', 'small primary');
      }
      return '';
    };

    const recordingStatus = () => {
      if (active) {
        if (capture.asrActive) {
          return '即時轉寫已連線';
        }
        return '正在本地錄音';
      }
      return `${m.segments.length} 個片段`;
    };

    return (
      <>
        <div className="record-strip">
          <span id="record-badge">{badge(active ? 'recording' : m.status)}</span>
          <RecordTimer capture={capture} duration={m.duration} active={active} />
          <span className="help" id="asr-status">
            {recordingStatus()}
          </span>
          <div className="button-row">
            {recordingControls()}
            {btn('版本歷史', 'revisions', 'history', 'small text')}
            <Button
              variant="ghost"
              size="sm"
              className="btn text small"
              data-delete-meeting={m.id}
              aria-label="刪除會議"
              title="刪除會議"
            >
              {icon('trash')}
            </Button>
          </div>
        </div>
        <WorkspacePanels
          panes={[
            <section className="workspace-pane" key="source" aria-label="會議來源">
              <div className="tabs">
                <button
                  className={`tab ${state.sourceTab === 'transcript' ? 'active' : ''}`}
                  data-source-tab="transcript"
                >
                  逐字稿
                </button>
                <button
                  className={`tab ${state.sourceTab === 'audio' ? 'active' : ''}`}
                  data-source-tab="audio"
                >
                  音訊
                </button>
              </div>
              <div className="pane-body" id="source-body">
                <AudioJobs state={state} meetingId={m.id} />
                {sourceBody(m)}
              </div>
            </section>,
            <NotesPane key="notes" meeting={m} state={state} />,
            <section className="workspace-pane agent-pane" key="agent" aria-label="Agent 助手">
              <div className="agent-feed" id="agent-feed">
                {!m.chats.length && !state.agentEvents.length ? (
                  <div className="agent-intro">
                    {icon('sparkle')}
                    <h3>一起整理，讓重點清楚。</h3>
                    <p>參考這場會議與專案檔案，協助撰寫、核對與修訂紀錄。</p>
                    <button
                      className="prompt-chip"
                      data-prompt="請整理完整會議紀錄，包含摘要、決議與待辦事項。"
                    >
                      整理摘要、決議與待辦 {icon('arrow')}
                    </button>
                    <button
                      className="prompt-chip"
                      data-prompt="請參考已選取的專案檔案，核對會議中的專有名詞，修正紀錄並保留引用。"
                    >
                      參考專案，核對專有名詞 {icon('arrow')}
                    </button>
                    <button
                      className="prompt-chip"
                      data-prompt="請將會議紀錄中的待辦事項整理為表格，列出負責人與期限，不明處標記待確認。"
                    >
                      整理待辦事項表格 {icon('arrow')}
                    </button>
                  </div>
                ) : (
                  ''
                )}
                {agentFeed()}
              </div>
              <div className="agent-composer">
                <div id="agent-queue">{queueView(state)}</div>
                <AgentInput key={m.id} state={state} meeting={m} />
              </div>
            </section>,
          ]}
        />
      </>
    );
  }

  return {
    workspacePage,
  };
}
