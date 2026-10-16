import { useEffect, useRef, useState } from 'react';
import type { FilePage, WorkspaceOptions } from '../../../domain/workspace';
import { Button } from '../../primitives/button';

export type { FilePage } from '../../../domain/workspace';

export function FilePreview({
  rootId,
  relative,
  read,
}: {
  rootId: string;
  relative: string;
  read: (rootId: string, relative: string, options?: WorkspaceOptions) => Promise<FilePage>;
}) {
  const [page, setPage] = useState<FilePage>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [history, setHistory] = useState<number[]>([]),
    sequence = useRef(0);
  useEffect(() => {
    void load(0, []);
    return () => {
      sequence.current++;
    };
  }, [rootId, relative]);

  async function load(offset: number, previous: number[], version?: string) {
    const request = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const next = await read(rootId, relative, { offset, limit: 16000, version });
      if (sequence.current === request) {
        setPage(next);
        setHistory(previous);
      }
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (sequence.current === request) setError(e.message);
    } finally {
      if (sequence.current === request) setBusy(false);
    }
  }

  const pageStatus = () => {
    if (busy) {
      return '讀取中…';
    }
    if (page) {
      return `offset ${page.offset} · ${page.unit} · ${page.nextOffset === null ? '最後一段' : `下一段 ${page.nextOffset}`}`;
    }
    return '';
  };

  return (
    <section aria-label="分段檔案預覽">
      <div className="button-row">
        <Button
          variant="ghost"
          size="bare"
          className="btn text small"
          disabled={busy || !history.length}
          onClick={() => void load(history.at(-1), history.slice(0, -1), page.version)}
        >
          上一段
        </Button>
        <Button
          variant="ghost"
          size="bare"
          className="btn text small"
          disabled={busy || !page || page.nextOffset === null}
          onClick={() => void load(page.nextOffset, [...history, page.offset], page.version)}
        >
          下一段
        </Button>
        <span className="help" role="status">
          {pageStatus()}
        </span>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          <Button
            variant="ghost"
            size="bare"
            className="btn text small"
            onClick={() => void load(0, [])}
          >
            重新讀取
          </Button>
        </p>
      )}
      <pre id="project-file-preview" className="code-field" hidden={!page}>
        {page?.text || ''}
      </pre>
    </section>
  );
}
