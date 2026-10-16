import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../../domain/models';
import { SpeechTestPanel } from '../../audio/testing/speech-panel';
import { Button } from '../../primitives/button';
import type { UiRuntime } from '../runtime';

export function AgentTestPanel({ settings }: { settings: Settings }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('會實際呼叫所選 Agent 與模型，回傳一段測試文字。');
  const [reply, setReply] = useState(''),
    [error, setError] = useState('');
  const alive = useRef(true),
    active = useRef('');
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.studio.on('connection:event', (event) => {
      if (event.id === active.current && event.type === 'log') setMessage(event.message);
    });
    return () => {
      alive.current = false;
      unsubscribe();
      if (active.current) void window.studio.invoke('connection:stop', active.current, false);
    };
  }, []);

  async function start() {
    if (busy) return;
    const id = crypto.randomUUID();
    active.current = id;
    setBusy(true);
    setReply('');
    setError('');
    setMessage('正在呼叫模型…');
    try {
      const result = await window.studio.invoke('connection:agent-test', id, settings);
      if (alive.current) {
        setReply(result.reply);
        setMessage('連線測試成功，已收到模型回覆。');
      }
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current) {
        setError(e.message);
        setMessage('連線測試未完成');
      }
    } finally {
      if (alive.current) setBusy(false);
      active.current = '';
    }
  }

  return (
    <div className="connection-test">
      <p className="help">
        使用本次表單選擇的認證方式、模型及 CLI 路徑。沿用 CLI 模式會使用目前的登入狀態。
        這是實際模型請求，會使用服務額度；測試不讀取專案檔案，也不保存對話。
      </p>
      <div className="button-row connection-actions">
        <Button className="btn primary" id="agent-connection-start" onClick={start} disabled={busy}>
          {busy ? '測試中…' : '測試 Agent 連線'}
        </Button>
        {busy && (
          <Button
            className="btn"
            variant="outline"
            onClick={() => window.studio.invoke('connection:stop', active.current, false)}
          >
            取消測試
          </Button>
        )}
      </div>
      <p role="status" id="agent-connection-status">
        {message}
      </p>
      {error && (
        <p className="notice error" role="alert" id="agent-connection-error">
          {error}
        </p>
      )}
      {reply && <blockquote id="agent-connection-reply">{reply}</blockquote>}
    </div>
  );
}

export function createDiagnosticController(host: UiRuntime) {
  return {
    open(settings: Settings, kind: 'asr' | 'agent') {
      if (host.capture?.active || host.capture?.starting) throw new Error('請先結束錄音再測試');
      host.showModal(
        kind === 'asr' ? '裝置與語音辨識連線測試' : 'Agent 模型連線測試',
        kind === 'asr' ? (
          <SpeechTestPanel
            settings={structuredClone(settings)}
            initialMicrophone={host.state.microphoneId || ''}
            initialDevice={
              ['system', 'both'].includes(host.state.source)
                ? host.state.source
                : `mic:${host.state.microphoneId || ''}`
            }
          />
        ) : (
          <AgentTestPanel settings={structuredClone(settings)} />
        )
      );
    },
  };
}
