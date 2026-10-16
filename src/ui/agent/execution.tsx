import { useEffect, useState } from 'react';
import type { ExecutionLimits } from '../../domain/agents/limits';
import { toolCallTraces, transcriptCoverage } from '../../domain/agents/trace';
import type { UiState } from '../../domain/models';
import { record } from '../../domain/value';
import { duration } from '../components/display';

export function AgentExecution({ state }: { state: UiState }) {
  const [now, setNow] = useState(Date.now());
  const events = state.agentEvents;
  const startedIndex = events.map((event) => event.type).lastIndexOf('started');
  const started = events[startedIndex];
  const running = !!state.runId && state.runId !== 'pending';
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, started?.id]);
  if (!started) return null;
  const current = events.slice(startedIndex);
  const calls = toolCallTraces(current);
  const coverage = transcriptCoverage(calls);
  const compaction = current.filter((event) => event.type === 'compaction').at(-1);
  const limits = (started.args as { limits?: ExecutionLimits })?.limits;
  const end = running ? now : Date.parse(current.at(-1)?.timestamp || started.timestamp);
  const elapsed = started.timestamp
    ? Math.max(0, Math.floor((end - Date.parse(started.timestamp)) / 1000))
    : undefined;
  const pending = calls
    .slice()
    .reverse()
    .find((call) => !call.output);

  const turnLimitLabel = () => {
    if (limits) {
      if (record(started.args).backend === 'codex') {
        return ' · Codex 回合由後端管理';
      }
      return ` · 模型回合上限 ${limits.maxSteps}`;
    }
    return '';
  };

  const timeoutLabel = () => {
    if (limits) {
      if (limits.timeoutMinutes) {
        return `${limits.timeoutMinutes} 分鐘`;
      }
      return '不限';
    }
    return '舊版未記錄';
  };

  const executionStatus = () => {
    if (running) {
      if (compaction?.status === 'running') {
        return '正在壓縮上下文';
      }
      if (pending) {
        return `正在執行 ${pending.input.name}`;
      }
      return '等待模型回應／整理提案中';
    }
    return '本次執行紀錄';
  };

  return (
    <section className="agent-execution" aria-label="Agent 執行進度">
      <strong>{executionStatus()}</strong>
      <p>
        {elapsed !== undefined ? `已執行 ${duration(elapsed)} · ` : ''}
        時間上限：
        {timeoutLabel()}
      </p>
      <p>
        工具呼叫 {calls.length} / {limits ? limits.maxToolCalls || '不限' : '未記錄'}
        {turnLimitLabel()}
      </p>
      {coverage.total > 0 && (
        <p>
          已取得 {coverage.received} / {coverage.total} 個逐字稿片段（不重複計數）
        </p>
      )}
    </section>
  );
}
