import { Popover } from 'radix-ui';
import { useState } from 'react';
import type { UiState } from '../../../domain/models';
import { icon } from '../../components/icons';
import { notify } from '../../layout/notifications';
import { invalidateUI } from '../../layout/roots';
import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import { toggleTemporary } from './temporary';

export function PermissionMenu({ state }: { state: UiState }) {
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const mode = state.agentMode || 'edit';
  const busy = !!state.runId || !!state.agentQueue?.length;
  return (
    <Popover.Root>
      <Popover.Trigger
        className="composer-access composer-permissions"
        title="Agent 權限與暫時對話"
        aria-label={`Agent 權限：${mode === 'read' ? '唯讀模式' : '編修模式'}${state.temporaryChat ? '，暫時對話' : ''}`}
      >
        {icon(mode === 'read' ? 'file' : 'edit')}
        <span>{mode === 'read' ? '唯讀模式' : '編修模式'}</span>
        {state.temporaryChat ? <span className="temporary-dot" aria-label="暫時對話啟用" /> : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="permission-menu"
          side="top"
          align="start"
          sideOffset={12}
          collisionPadding={12}
        >
          <div className="mention-section-label">Agent 權限</div>
          {(
            [
              ['edit', '編修模式', '產生修改提案，確認後套用至會議紀錄'],
              ['read', '唯讀模式', '搜尋、閱讀與回答；不產生可套用的修訂'],
            ] as const
          ).map(([value, label, description]) => (
            <Button
              variant="ghost"
              size="bare"
              type="button"
              key={value}
              className="permission-option"
              aria-pressed={mode === value}
              onClick={() => {
                state.agentMode = value;
                if (value === 'read') state.proposal = null;
                invalidateUI();
              }}
            >
              {icon(value === 'read' ? 'file' : 'edit')}
              <span>
                <strong>{label}</strong>
                <span>{description}</span>
              </span>
              {mode === value ? icon('check') : null}
            </Button>
          ))}
          <label className="temporary-toggle">
            <span>
              <strong>暫時對話</strong>
              <span>離開會議工作區即清除對話與附件</span>
            </span>
            <Checkbox
              aria-label="暫時對話"
              checked={pending ? requested : !!state.temporaryChat}
              disabled={pending || busy}
              aria-busy={pending}
              onCheckedChange={async (checked) => {
                setRequested(checked === true);
                setPending(true);
                try {
                  await toggleTemporary(state, checked === true);
                } catch (caughtE) {
                  const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

                  notify(e.message, true);
                } finally {
                  setPending(false);
                }
              }}
            />
          </label>
          {busy && (
            <p className="help">暫時對話需先停止工作並清空佇列；新權限會套用至下一則訊息。</p>
          )}
          <Popover.Arrow className="permission-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
