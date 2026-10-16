import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Reference } from '../../domain/models';
import type { WorkspaceOptions } from '../../domain/workspace';
import { icon } from '../components/icons';
import { Button } from '../primitives/button';
import { Input } from '../primitives/input';
import { type FilePage, FilePreview } from './files/preview';

interface Options {
  showModal: (title: ReactNode, body: ReactNode) => HTMLDialogElement;
  list: (
    query: string,
    cursor?: string
  ) => Promise<{
    files: Reference[];
    errors: string[];
    nextCursor: string | null;
    stats: { visited: number };
  }>;
  read: (rootId: string, relative: string, options?: WorkspaceOptions) => Promise<FilePage>;
  release: (cursor: string) => Promise<unknown>;
}

export async function openProjectFiles(options: Options) {
  options.showModal('搜尋專案檔案', <ProjectFiles options={options} />);
}

function ProjectFiles({ options }: { options: Options }) {
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('掃描中…'),
    [busy, setBusy] = useState(false);
  const [file, setFile] = useState<Reference>(),
    [files, setFiles] = useState<Reference[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const sequence = useRef(0),
    activeCursor = useRef<string>(null),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    return () => {
      sequence.current++;
      if (activeCursor.current) void options.release(activeCursor.current);
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    setFile(undefined);
    setFiles([]);
    setBusy(true);
    setCursor(null);
    if (activeCursor.current) {
      void options.release(activeCursor.current);
      activeCursor.current = null;
    }
    const timer = setTimeout(() => void load(), 180);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [query]);

  async function load(next?: string) {
    const request = ++sequence.current;
    setBusy(true);
    setStatus('背景掃描中…');
    try {
      const result = await options.list(query, next);
      if (request !== sequence.current) {
        if (result.nextCursor) void options.release(result.nextCursor);
        return;
      }
      setFiles(result.files);
      setCursor(result.nextCursor);
      activeCursor.current = result.nextCursor;
      setStatus(
        `本批 ${result.files.length} 個檔案 · 已檢查 ${result.stats.visited} 個項目${result.nextCursor ? ' · 可繼續下一批' : ' · 掃描完成'}${result.errors.length ? ` · ${result.errors.join('；')}` : ''}`
      );
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (request === sequence.current) setStatus(e.message);
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  return (
    <>
      <Input
        ref={input}
        id="file-search"
        data-initial-focus
        aria-label="搜尋檔案"
        placeholder="搜尋檔名…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p id="project-file-status" className="help" role="status">
        {status}
      </p>
      <div className="button-row">
        <Button
          variant="ghost"
          size="bare"
          className="btn text small"
          disabled={busy || !cursor}
          onClick={() => void load(cursor)}
        >
          下一批檔案
        </Button>
        <Button
          variant="ghost"
          size="bare"
          className="btn text small"
          disabled={busy}
          onClick={() => {
            if (activeCursor.current) void options.release(activeCursor.current);
            void load();
          }}
        >
          重新掃描
        </Button>
      </div>
      <div id="project-files">
        {files.map((f, i) => (
          <div className="file-list-item" key={`${f.rootId}:${f.relative}`}>
            {icon('file')}
            <div>
              <Button variant="ghost" size="bare" data-file-index={i} onClick={() => setFile(f)}>
                {f.relative}
              </Button>
              <small>{f.rootName}</small>
            </div>
          </div>
        ))}
      </div>
      {file && (
        <FilePreview
          key={`${file.rootId}:${file.relative}`}
          rootId={file.rootId}
          relative={file.relative}
          read={options.read}
        />
      )}
    </>
  );
}
