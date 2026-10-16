import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Project, WorkspaceRoot } from '../../domain/models';
import { renderNodeInto } from '../layout/roots';
import { Button } from '../primitives/button';
import { Input } from '../primitives/input';
import { icon } from './icons';

interface EditorOptions {
  project: Project;
  removeRootId?: string;
  showModal: (title: ReactNode, body: ReactNode, footer?: ReactNode) => HTMLDialogElement;
  pickFolders: () => Promise<WorkspaceRoot[]>;
  save: (name: string, roots: string[]) => Promise<Project>;
}

export function openProjectEditor(options: EditorOptions): Promise<Project | 'remove' | null> {
  return new Promise((resolve) => {
    const modal = options.showModal('編輯專案', null);
    modal.classList.add('project-editor-dialog');
    let finished = false;

    const finish = (value: Project | 'remove' | null) => {
      if (finished) return;
      finished = true;
      modal.close();
      modal.classList.remove('project-editor-dialog');
      modal.removeAttribute('aria-busy');
      resolve(value);
    };

    renderNodeInto(modal, <ProjectEditor options={options} modal={modal} finish={finish} />);
  });
}

function ProjectEditor({
  options,
  modal,
  finish,
}: {
  options: EditorOptions;
  modal: HTMLDialogElement;
  finish: (value: Project | 'remove' | null) => void;
}) {
  const [roots, setRoots] = useState(() =>
    options.project.roots.filter((r) => r.id !== options.removeRootId)
  );
  const [name, setName] = useState(options.project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    add = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false),
    alive = useRef(true);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.setSelectionRange(name.length, name.length);
  }, []);
  useEffect(() => {
    alive.current = true;

    const cancel = (event: Event) => {
      event.preventDefault();
      if (!busyRef.current) finish(null);
    };

    const closed = () => {
      if (!modal.open) {
        alive.current = false;
        finish(null);
      }
    };

    modal.addEventListener('cancel', cancel);
    modal.addEventListener('close', closed);
    return () => {
      alive.current = false;
      modal.removeEventListener('cancel', cancel);
      modal.removeEventListener('close', closed);
    };
  }, [modal]);
  useEffect(() => {
    busyRef.current = busy;
    modal.setAttribute('aria-busy', String(busy));
  }, [busy, modal]);

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  async function pick() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const selected = await options.pickFolders();
      if (alive.current)
        setRoots((existing) => [
          ...existing,
          ...selected.filter((r) => !existing.some((e) => e.id === r.id)),
        ]);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current) report(e);
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        requestAnimationFrame(() => add.current?.focus());
      }
    }
  }

  async function save() {
    if (busyRef.current) return;
    if (!name.trim()) {
      setError('請輸入專案名稱');
      input.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await options.save(
        name,
        roots.map((r) => r.id)
      );
      if (alive.current) finish(saved);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current) report(e);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-head">
        <h2>編輯專案</h2>
        <button data-close-modal aria-label="關閉" disabled={busy} onClick={() => finish(null)}>
          {icon('x')}
        </button>
      </div>
      <div className="modal-body">
        <label className="project-name-field">
          {icon('folder')}
          <Input
            ref={input}
            id="name-input"
            aria-label="專案名稱"
            maxLength={120}
            autoComplete="off"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              }
            }}
          />
        </label>
        <h3 id="project-folders-label">來源資料夾</h3>
        <div className="project-folder-list" role="group" aria-labelledby="project-folders-label">
          <div id="project-editor-roots">
            {roots.map((root) => (
              <div className="project-editor-root" key={root.id}>
                {icon('folder')}
                <span title={root.path}>{root.name}</span>
                <button
                  type="button"
                  data-editor-remove-root={root.id}
                  aria-label={`移除 ${root.name}`}
                  disabled={busy}
                  onClick={() => {
                    setRoots(roots.filter((r) => r.id !== root.id));
                    add.current?.focus();
                  }}
                >
                  {icon('x')}
                </button>
              </div>
            ))}
          </div>
          <button
            id="project-editor-add"
            ref={add}
            type="button"
            disabled={busy}
            onClick={() => void pick()}
          >
            {icon('folder')}
            <span>新增資料夾</span>
            {icon('plus', 'folder-plus')}
          </button>
        </div>
        <p id="project-editor-error" className="error" role="alert" hidden={!error}>
          {error}
        </p>
      </div>
      <div className="modal-footer">
        <Button
          id="project-editor-remove"
          variant="ghost"
          disabled={busy}
          onClick={() => finish('remove')}
        >
          移除本機專案
        </Button>
        <span className="project-editor-spacer" />
        <Button
          id="project-editor-cancel"
          variant="ghost"
          disabled={busy}
          onClick={() => finish(null)}
        >
          取消
        </Button>
        <Button id="name-confirm" disabled={busy} onClick={() => void save()}>
          儲存
        </Button>
      </div>
    </>
  );
}
