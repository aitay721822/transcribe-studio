import { useState } from 'react';
import { type ToolCallTrace, toolSummary } from '../../domain/agents/trace';
import { record } from '../../domain/value';

function JsonDetail({ label, value }: { label: string; value: unknown }) {
  const [copied, setCopied] = useState('');
  const text = JSON.stringify(value ?? null, null, 2);
  return (
    <section className="agent-json-detail">
      <div>
        <strong>{label}</strong>
        <button
          type="button"
          className="btn text small"
          onClick={async () => {
            try {
              await window.studio.invoke('clipboard:write', text);
              setCopied('已複製');
            } catch {
              setCopied('複製失敗');
            }
          }}
        >
          {copied || '複製完整內容'}
        </button>
      </div>
      <pre tabIndex={0} aria-label={label}>
        {text}
      </pre>
    </section>
  );
}

export function ToolTrace({ call, running }: { call: ToolCallTrace; running: boolean }) {
  const [open, setOpen] = useState(false);
  const output = call.output;
  const failed = output?.status === 'error' || !!record(output?.result).error;

  const toolStatus = () => {
    if (output?.status === 'cancelled') {
      return '已中止';
    }
    if (output) {
      if (failed) {
        return '失敗';
      }
      return '完成';
    }
    if (running) {
      return '執行中';
    }
    return '未完成';
  };

  const status = toolStatus();

  const completionTime = () => {
    if (output?.timestamp) {
      return new Date(output.timestamp).toLocaleString('zh-TW');
    }
    if (output) {
      return '舊版紀錄未提供';
    }
    return '尚未完成';
  };

  return (
    <details
      className="agent-tool-trace"
      data-tool={call.input.name}
      data-status={status}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>
          <strong>{call.input.name}</strong>
          <small>{toolSummary(call)}</small>
        </span>
        <span className="agent-tool-state">
          {status}
          {output?.durationMs !== undefined ? ` · ${(output.durationMs / 1000).toFixed(2)} 秒` : ''}
        </span>
      </summary>
      {call.repetition > 1 && (
        <p className="agent-tool-repeat">同一組參數已呼叫 {call.repetition} 次</p>
      )}
      {open && (
        <div className="agent-tool-body">
          <JsonDetail label="傳入參數" value={call.input.args} />
          {output ? (
            <JsonDetail label="output（完整回傳）" value={output.result} />
          ) : (
            <p className="help">尚未收到 output。</p>
          )}
          <dl>
            <dt>呼叫 ID</dt>
            <dd>{call.input.callId || '舊版紀錄未提供'}</dd>
            <dt>開始時間</dt>
            <dd>
              {call.input.timestamp
                ? new Date(call.input.timestamp).toLocaleString('zh-TW')
                : '舊版紀錄未提供'}
            </dd>
            <dt>結束時間</dt>
            <dd>{completionTime()}</dd>
          </dl>
        </div>
      )}
    </details>
  );
}
