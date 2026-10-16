import { useLayoutEffect, useRef, useState } from 'react';
import type { Meeting, Project } from '../../domain/models';
import { icon } from '../components/icons';
import { mountOverlay } from '../layout/overlays';
import { Input } from '../primitives/input';

type QuickAction = 'new-meeting' | 'add-folder' | 'find-files';
interface PaletteOptions {
  meetings: Meeting[];
  projects: Project[];
  openMeeting: (id: string) => Promise<void>;
  quickAction: (action: QuickAction) => Promise<void>;
  onError: (error: unknown) => void;
}
const quick = [
  {
    action: 'new-meeting' as const,
    label: '新增會議',
    glyph: 'edit',
    key: 'Ctrl+N',
    letter: 'n',
  },
  {
    action: 'add-folder' as const,
    label: '加入參考資料夾',
    glyph: 'folder',
    key: 'Ctrl+O',
    letter: 'o',
  },
  {
    action: 'find-files' as const,
    label: '搜尋檔案',
    glyph: 'search',
    key: 'Ctrl+P',
    letter: 'p',
  },
];

export function openSearchPalette(options: PaletteOptions) {
  const existing = document.querySelector<HTMLDialogElement>('#search-palette');
  if (existing?.open) {
    existing.querySelector<HTMLInputElement>('input')?.focus();
    return;
  }
  const previous = document.activeElement as HTMLElement;
  mountOverlay((dismiss) => (
    <SearchPalette
      options={options}
      close={() => {
        dismiss();
        if (previous?.isConnected) previous.focus();
      }}
    />
  ));
}

function SearchPalette({ options, close }: { options: PaletteOptions; close: () => void }) {
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);

  const projectName = (meeting: Meeting) =>
    options.projects.find((p) => p.id === meeting.projectId)?.name || '未分類';

  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const found = [...options.meetings]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter((meeting) => {
      const text =
        `${meeting.title} ${projectName(meeting)} ${meeting.notes} ${meeting.segments.map((s) => s.text).join(' ')} ${meeting.chats.map((m) => m.text).join(' ')}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .slice(0, 9);
  const visibleQuick = quick.filter((action) => terms.every((term) => action.label.includes(term)));
  const entries: {
    meeting?: Meeting;
    action?: QuickAction;
  }[] = [
    ...found.map((meeting) => ({
      meeting,
    })),
    ...visibleQuick.map(({ action }) => ({
      action,
    })),
  ];

  const choose = (entry: (typeof entries)[number]) => {
    if (!entry) return;
    close();
    (entry.meeting
      ? options.openMeeting(entry.meeting.id)
      : options.quickAction(entry.action)
    ).catch(options.onError);
  };

  useLayoutEffect(() => {
    dialog.current.showModal();
    input.current?.focus();
  }, []);
  useLayoutEffect(() => {
    dialog.current?.querySelector(`#palette-result-${active}`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [active, query]);
  return (
    <dialog
      ref={dialog}
      id="search-palette"
      className="search-palette"
      aria-label="搜尋會議與快速操作"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
      onClose={close}
      onClick={(e) => {
        const rect = dialog.current.getBoundingClientRect();
        if (
          e.target === dialog.current &&
          (e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom)
        )
          close();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        const action =
          (e.ctrlKey || e.metaKey) && quick.find((item) => item.letter === e.key.toLowerCase());
        if (action) {
          e.preventDefault();
          e.stopPropagation();
          choose({
            action: action.action,
          });
          return;
        }
        if (e.altKey && /^[1-9]$/.test(e.key)) {
          e.preventDefault();
          choose(entries.filter((entry) => entry.meeting)[Number(e.key) - 1]);
          return;
        }
        if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
          e.preventDefault();
          setActive(
            entries.length
              ? (active + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
              : 0
          );
        } else if (e.key === 'Enter') {
          e.preventDefault();
          choose(entries[active]);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          input.current?.focus();
        }
      }}
    >
      <Input
        ref={input}
        id="palette-query"
        type="search"
        role="combobox"
        aria-label="搜尋會議"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="palette-results"
        aria-activedescendant={entries[active] ? `palette-result-${active}` : undefined}
        placeholder="搜尋會議"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
      />
      <div id="palette-results" role="listbox" aria-label="搜尋結果">
        <div className="palette-section">會議</div>
        {found.length ? (
          found.map((meeting, index) => (
            <button
              key={meeting.id}
              id={`palette-result-${index}`}
              className={`palette-result ${active === index ? 'is-active' : ''}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={active === index}
              data-index={index}
              onClick={() =>
                choose({
                  meeting,
                })
              }
              onPointerMove={() => setActive(index)}
            >
              <span className="palette-result-state">
                {['recording', 'transcribing'].includes(meeting.status) ? icon('wave') : null}
              </span>
              <span className="palette-result-title">{meeting.title}</span>
              <span className="palette-result-project" title={projectName(meeting)}>
                {projectName(meeting)}
              </span>
              <kbd>Alt+{index + 1}</kbd>
            </button>
          ))
        ) : (
          <div className="palette-empty">
            {query ? '沒有符合的會議' : '還沒有會議，從下方開始新增'}
          </div>
        )}
        {!!visibleQuick.length && (
          <div className="palette-section palette-quick-heading">快速動作</div>
        )}
        {visibleQuick.map((action, index) => (
          <button
            key={action.action}
            id={`palette-result-${found.length + index}`}
            className={`palette-result palette-quick ${active === found.length + index ? 'is-active' : ''}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={active === found.length + index}
            data-index={found.length + index}
            onClick={() =>
              choose({
                action: action.action,
              })
            }
            onPointerMove={() => setActive(found.length + index)}
          >
            {icon(action.glyph)}
            <span className="palette-result-title">{action.label}</span>
            <kbd>{action.key}</kbd>
          </button>
        ))}
      </div>
      <p className="palette-announcement" role="status" aria-live="polite">
        {found.length} 場會議，{visibleQuick.length} 個快速動作
      </p>
    </dialog>
  );
}
