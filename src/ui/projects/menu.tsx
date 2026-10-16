import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { Project } from '../../domain/models';
import { icon } from '../components/icons';
import { mountOverlay } from '../layout/overlays';
import { Button } from '../primitives/button';

export type ProjectCommand =
  | 'pin'
  | 'edit'
  | 'section'
  | 'new-section'
  | 'open'
  | 'archive'
  | 'remove'
  | 'create';

let closeActive: (focus?: boolean) => void = () => {};

export function closeProjectMenu() {
  closeActive(false);
}

export function openProjectMenu(
  trigger: HTMLButtonElement,
  project: Project | undefined,
  projects: Project[],
  run: (command: ProjectCommand, value?: string) => void
) {
  closeProjectMenu();
  trigger.setAttribute('aria-expanded', 'true');
  const dismiss = mountOverlay((close) => {
    const finish = (focus = true) => {
      close();
      trigger.setAttribute('aria-expanded', 'false');
      closeActive = () => {};
      if (focus && trigger.isConnected) trigger.focus();
    };

    closeActive = finish;
    return (
      <ProjectMenu
        trigger={trigger}
        project={project}
        projects={projects}
        run={run}
        close={finish}
      />
    );
  }, trigger.closest('.sidebar') || document.body);
  return dismiss;
}

function ProjectMenu({
  trigger,
  project,
  projects,
  run,
  close,
}: {
  trigger: HTMLButtonElement;
  project?: Project;
  projects: Project[];
  run: (command: ProjectCommand, value?: string) => void;
  close: (focus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<'main' | 'sections' | 'folders'>('main');
  useLayoutEffect(() => {
    menu.current.showPopover();

    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.contains(event.target as Node))
        close(false);
    };

    const resize = () => close(false);

    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close(false);
    };

    const escape = (event: KeyboardEvent) => {
      if (['Escape', 'Tab'].includes(event.key)) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        close();
      }
    };

    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', resize);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', resize);
      document.removeEventListener('scroll', scroll, true);
    };
  }, []);
  useLayoutEffect(() => {
    const box = menu.current,
      rect = trigger.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(rect.bottom + 5, innerHeight - box.offsetHeight - 8))}px`;
    box.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [screen]);

  const choose = (command: string, value = '') => {
    if (command === 'sections') {
      setScreen('sections');
      return;
    }
    if (command === 'folders' && project && project.roots.length > 1) {
      setScreen('folders');
      return;
    }
    if (command === 'back') {
      setScreen('main');
      return;
    }
    close();
    run(command === 'folders' ? 'open' : (command as ProjectCommand), value);
  };

  const item = (
    command: string,
    label: string,
    glyph: string,
    value = '',
    end: ReactNode = null
  ) => (
    <Button
      variant="ghost"
      size="bare"
      type="button"
      role="menuitem"
      data-command={command}
      data-value={value}
      disabled={command === 'folders' && !project?.roots.length}
      title={command === 'folders' && !project?.roots.length ? '請先新增來源資料夾' : undefined}
      onClick={() => choose(command, value)}
    >
      {icon(glyph)}
      <span>{label}</span>
      {end}
    </Button>
  );

  const separator = <div role="separator" />;
  let content: ReactNode;
  if (screen === 'sections' && project)
    content = (
      <>
        {item('back', '區段', 'down')}
        {separator}
        {['', ...new Set(projects.map((p) => p.section || '').filter(Boolean))].map((section) => (
          <Fragment key={section}>
            {item(
              'section',
              section || '專案（預設）',
              'list',
              section,
              (project.section || '') === section ? icon('check') : null
            )}
          </Fragment>
        ))}
        {separator}
        {item('new-section', '新增區段…', 'plus')}
      </>
    );
  else if (screen === 'folders' && project)
    content = (
      <>
        {item('back', '來源資料夾', 'down')}
        {separator}
        {project.roots.map((root) => (
          <Fragment key={root.id}>{item('open', root.name, 'folder', root.id)}</Fragment>
        ))}
      </>
    );
  else
    content = project ? (
      <>
        {item('pin', project.pinned ? '取消釘選專案' : '釘選專案', 'pin')}
        {item('edit', '編輯', 'settings')}
        {separator}
        {item('sections', '區段', 'list', '', icon('arrow'))}
        {item('folders', '在檔案總管中開啟', 'folder')}
        {separator}
        {item('archive', project.archivedAt ? '解除封存' : '封存專案', 'archive')}
        {separator}
        {item('remove', '移除專案', 'x')}
        {trigger.classList.contains('project-heading-menu') ? (
          <>
            {separator}
            {item('create', '新增專案', 'plus')}
          </>
        ) : null}
      </>
    ) : (
      item('create', '新增專案', 'plus')
    );
  return (
    <div
      ref={menu}
      className="project-context-menu"
      popover="manual"
      role="menu"
      aria-label={project ? `${project.name} 的專案操作` : '專案操作'}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [
              ...menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            ],
            index = buttons.indexOf(document.activeElement as HTMLButtonElement);

          const destinationIndex = () => {
            if (event.key === 'Home') {
              return 0;
            }
            if (event.key === 'End') {
              return buttons.length - 1;
            }
            return (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          };

          const next = destinationIndex();
          buttons[next]?.focus();
        } else if (
          event.key === 'ArrowRight' &&
          document.activeElement?.getAttribute('data-command') === 'sections'
        ) {
          event.preventDefault();
          setScreen('sections');
        } else if (event.key === 'ArrowLeft' && screen !== 'main') {
          event.preventDefault();
          setScreen('main');
        }
      }}
    >
      {content}
    </div>
  );
}
