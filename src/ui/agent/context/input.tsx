import { useEffect, useState } from 'react';
import type { Meeting, UiState } from '../../../domain/models';
import { notify } from '../../layout/notifications';
import { Textarea } from '../../primitives/textarea';
import { addImages, ImageAttachments, ImagePicker } from '../session/images';
import { discardTemporary } from '../session/temporary';
import { ComposerControls } from './controls';
import { ReferenceChips } from './mentions/chips';
import { useMentions } from './mentions/controller';
import { MentionMenu } from './mentions/menu';
import { mentionToken } from './mentions/token';
import { ReplyQuotes } from './quotes';

const commands = [
  ['/compact', '壓縮上下文，保留完整原始紀錄'],
  ['/clear', '清空目前對話並重設 session，保留會議內容'],
  ['/help', '查看指令說明'],
];

export function AgentInput({ state, meeting }: { state: UiState; meeting: Meeting }) {
  const mentions = useMentions(state, meeting);
  const temporaryId = state.temporaryChat?.id;
  useEffect(
    () => () => {
      if (temporaryId) discardTemporary(state, temporaryId);
    },
    [temporaryId, meeting.id]
  );
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState(0);
  const options = query.startsWith('/')
    ? commands.filter(([name]) => name.startsWith(query.toLowerCase()))
    : [];

  function choose(command: string) {
    const input = document.getElementById('agent-input') as HTMLTextAreaElement;
    input.value = command;
    setQuery('');
    input.focus();
  }

  function openSources() {
    if (mentions.token) {
      mentions.close();
      return;
    }
    const input = document.getElementById('agent-input') as HTMLTextAreaElement;
    input.focus();
    if (mentionToken(input)) {
      mentions.update(input, true);
      return;
    }
    const start = input.selectionStart;
    const prefix = start && !/[\s(]/.test(input.value[start - 1]) ? ' @' : '@';
    input.setRangeText(prefix, start, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mentions.update(input, true);
  }

  const activeSuggestionId = () => {
    if (mentions.token && mentions.options.length) {
      return `reference-option-${mentions.selected}`;
    }
    if (options.length) {
      return `agent-command-${selected}`;
    }
    return undefined;
  };

  const suggestionsId = () => {
    if (mentions.token) {
      return 'agent-reference-list';
    }
    if (options.length) {
      return 'agent-command-list';
    }
    return undefined;
  };

  return (
    <div
      className={`agent-input-wrap${temporaryId ? ' is-temporary' : ''}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={async (event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        try {
          await addImages(state, meeting.id, Array.from(event.dataTransfer.files));
        } catch (caughtE) {
          const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

          notify(e.message, true);
        }
      }}
    >
      <ReplyQuotes state={state} meeting={meeting} />
      <ReferenceChips state={state} meeting={meeting} />
      <ImageAttachments state={state} meeting={meeting} />
      <ImagePicker state={state} meeting={meeting} />
      <MentionMenu menu={mentions} />
      {options.length > 0 && (
        <div className="slash-menu" role="listbox" id="agent-command-list" aria-label="Agent 指令">
          {options.map(([name, description], index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selected}
              id={`agent-command-${index}`}
              key={name}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(name)}
            >
              <strong>{name}</strong>
              <span>{description}</span>
            </button>
          ))}
        </div>
      )}
      <Textarea
        id="agent-input"
        placeholder={temporaryId ? '暫時對話，離開後清除' : '輸入訊息，@ 指定來源，/ 選擇指令'}
        onPaste={async (event) => {
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/')
          );
          if (!files.length) return;
          event.preventDefault();
          try {
            await addImages(state, meeting.id, files);
          } catch (caughtE) {
            const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

            notify(e.message, true);
          }
        }}
        aria-label="Agent 指令"
        defaultValue=""
        aria-controls={suggestionsId()}
        aria-expanded={!!mentions.token || options.length > 0}
        aria-autocomplete="list"
        aria-activedescendant={activeSuggestionId()}
        onInput={(e) => {
          setQuery(e.currentTarget.value.trim());
          setSelected(0);
          if (!e.nativeEvent.isComposing) mentions.update(e.currentTarget);
        }}
        onSelect={(e) => mentions.update(e.currentTarget)}
        onCompositionEnd={(e) => mentions.update(e.currentTarget)}
        onBlur={(e) => {
          if (!(e.relatedTarget as HTMLElement)?.closest('.mention-menu')) mentions.close();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (mentions.onKeyDown(e)) return;
          if (e.key === 'Escape') {
            setQuery('');
            e.stopPropagation();
          }
          if (
            options.length &&
            (['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key) ||
              (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey))
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'ArrowDown') setSelected((selected + 1) % options.length);
            else if (e.key === 'ArrowUp')
              setSelected((selected + options.length - 1) % options.length);
            else choose(options[selected][0]);
          }
        }}
      />
      <ComposerControls state={state} openSources={openSources} sourcesOpen={!!mentions.token} />
      {state.selectionLength ? (
        <small id="selection-status">
          已選取 {state.selectionLength} 字，Agent 將參考這段內容。
        </small>
      ) : null}
    </div>
  );
}
