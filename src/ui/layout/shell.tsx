import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { Button } from '../primitives/button';
import { SetupScreen } from '../setup/screen';
import { renderNodeInto, useUiRevision } from './roots';

export interface ShellContent {
  title: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
  events: HTMLAttributes<HTMLDivElement>;
  standalone?: 'setup' | 'settings';
}
const breakpoint = '(max-width: 900px)';
const widthKey = 'studio.sidebar.width';
const collapsedKey = 'studio.sidebar.collapsed';

let toggle: () => void = () => {};

export function toggleSidebar(): void {
  toggle();
}

export function renderShell(content: () => ShellContent): void {
  renderNodeInto(document.getElementById('app'), <Application content={content} />);
}

function Application({ content }: { content: () => ShellContent }) {
  useUiRevision();
  const view = content();
  if (view.standalone === 'settings')
    return (
      <div className="shell panel-shell settings-shell" {...view.events}>
        <div className="title-slot">{view.title}</div>
        <div className="main-slot settings-main-slot">{view.main}</div>
      </div>
    );
  return view.standalone === 'setup' ? (
    <SetupScreen events={view.events}>{view.main}</SetupScreen>
  ) : (
    <Shell {...view} />
  );
}

function Shell(content: ShellContent) {
  const panelRef = usePanelRef();
  const [compact, setCompact] = useState(() => matchMedia(breakpoint).matches);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapsedKey) === 'true');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const width = useRef(Math.max(220, Math.min(360, Number(localStorage.getItem(widthKey)) || 246)));
  const titleRef = useRef<HTMLDivElement>(null);

  const closeDrawer = () => {
    setDrawerOpen(false);
    titleRef.current?.querySelector<HTMLButtonElement>('[data-action="collapse-sidebar"]')?.focus();
  };

  useEffect(() => {
    const media = matchMedia(breakpoint);

    const changed = () => {
      setCompact(media.matches);
      setDrawerOpen(false);
    };

    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    if (compact || collapsed) panelRef.current?.collapse();
    else panelRef.current?.resize(`${width.current}px`);
  }, [compact, collapsed, panelRef]);
  useLayoutEffect(() => {
    toggle = () => {
      if (compact) setDrawerOpen((open) => !open);
      else
        setCollapsed((value) => {
          localStorage.setItem(collapsedKey, String(!value));
          return !value;
        });
    };
    const button = titleRef.current?.querySelector<HTMLButtonElement>(
      '[data-action="collapse-sidebar"]'
    );
    button?.setAttribute(
      'aria-label',
      `${(compact ? !drawerOpen : collapsed) ? '展開' : '收合'}專案側欄`
    );
    button?.setAttribute('aria-expanded', String(compact ? drawerOpen : !collapsed));
    button?.setAttribute('aria-controls', 'project-navigation');
  });
  useEffect(() => {
    if (!compact || !drawerOpen) return;
    const navigation = document.getElementById('project-navigation');

    const focusable = () =>
      [
        ...navigation.querySelectorAll<HTMLButtonElement>('button, input, select, [tabindex="0"]'),
      ].filter((e) => !e.disabled && e.getClientRects().length);

    focusable()[0]?.focus();

    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
      }
      if (event.key === 'Tab') {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };

    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [compact, drawerOpen]);
  return (
    <div
      {...content.events}
      className={`shell panel-shell ${compact ? 'compact-shell' : ''} ${drawerOpen ? 'drawer-open' : ''} ${!compact && collapsed ? 'navigation-collapsed' : ''}`}
    >
      <div className="title-slot" ref={titleRef}>
        {content.title}
      </div>
      <Group
        id="application-layout"
        className="panel-layout"
        orientation="horizontal"
        disableCursor
        onLayoutChanged={(_, meta) => {
          if (compact || !meta.isUserInteraction) return;
          const size = panelRef.current?.getSize().inPixels || 0;
          if (size > 0) {
            width.current = size;
            localStorage.setItem(widthKey, String(size));
          }
          setCollapsed(size === 0);
          localStorage.setItem(collapsedKey, String(size === 0));
        }}
      >
        <Panel
          id="project-navigation"
          panelRef={panelRef}
          className="navigation-panel"
          defaultSize={`${width.current}px`}
          minSize={220}
          maxSize={360}
          collapsible
          collapsedSize={0}
          role={compact && drawerOpen ? 'dialog' : undefined}
          aria-modal={compact && drawerOpen ? true : undefined}
          aria-label="專案導覽"
        >
          <div
            className="sidebar-slot"
            onClick={(event) => {
              if (
                compact &&
                (event.target as HTMLElement).closest(
                  '[data-view], [data-project], [data-meeting], [data-action]'
                )
              )
                setDrawerOpen(false);
            }}
          >
            {content.sidebar}
          </div>
        </Panel>
        <Separator
          className="navigation-separator"
          aria-label="調整專案側欄寬度"
          disabled={compact}
        />
        <Panel id="application-content" minSize={320}>
          <div className="main-slot" inert={compact && drawerOpen}>
            {content.main}
          </div>
        </Panel>
      </Group>
      {compact && drawerOpen && (
        <Button
          variant="ghost"
          size="bare"
          className="navigation-backdrop"
          tabIndex={-1}
          aria-label="關閉專案側欄"
          onClick={closeDrawer}
        />
      )}
    </div>
  );
}
