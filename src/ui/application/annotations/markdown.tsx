import { Fragment, type ReactNode } from 'react';
import type { NoteAnnotation } from '../../../domain/annotations';
import type { Meeting } from '../../../domain/models';
import { SourceCitation, sourceCitation } from './citations';

export function markedText(text: string, start: number, marks: NoteAnnotation[] = []): ReactNode {
  const pending = marks.filter(
    (a) => a.status === 'pending' && a.start < start + text.length && a.end > start
  );
  const cuts = [
    ...new Set([
      0,
      text.length,
      ...pending.flatMap((a) => [
        Math.max(0, a.start - start),
        Math.min(text.length, a.end - start),
      ]),
    ]),
  ].sort((a, b) => a - b);
  return cuts.slice(0, -1).map((offset, i) => {
    const value = text.slice(offset, cuts[i + 1]),
      absolute = start + offset;
    const mark = pending.find((a) => a.start <= absolute && a.end > absolute);
    return (
      <span key={absolute} data-source-start={absolute}>
        {mark ? (
          <mark className="note-highlight" data-note-mark={mark.id} title={mark.comment}>
            {value}
          </mark>
        ) : (
          value
        )}
      </span>
    );
  });
}

function inline(
  text: string,
  start: number,
  marks?: NoteAnnotation[],
  meeting?: Meeting
): ReactNode {
  let offset = start;
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => {
    const strong = part.startsWith('**') && part.endsWith('**');
    const content = strong ? part.slice(2, -2) : part;
    let position = offset + (strong ? 2 : 0);
    const node = content.split(/(\[[^\]\n]{1,200}\])/).map((value, index) => {
      const id = value.slice(1, -1),
        at = position;
      position += value.length;
      if (value.startsWith('[') && sourceCitation(id, meeting))
        return (
          <SourceCitation key={index} id={id} meeting={meeting} start={at} length={value.length} />
        );
      return (
        <Fragment key={index}>
          {marks === undefined ? value : markedText(value, at, marks)}
        </Fragment>
      );
    });
    offset += part.length;
    return <Fragment key={i}>{strong ? <strong>{node}</strong> : node}</Fragment>;
  });
}

export function markdown(text: string, marks?: NoteAnnotation[], meeting?: Meeting): ReactNode {
  const lines = String(text).split('\n'),
    starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const nodes: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{3}/.test(lines[i + 1] || '')) {
      const rows = [{ line, start: starts[i] }];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push({ line: lines[i], start: starts[i] });
        i++;
      }
      i--;

      const cells = (row: (typeof rows)[number], header: boolean) => {
        const leading = row.line.indexOf('|') + 1,
          content = row.line.slice(leading).replace(/\|\s*$/, '');
        let pos = row.start + leading;
        return content.split('|').map((cell, j) => {
          const value = inline(
            cell.trim(),
            pos + cell.length - cell.trimStart().length,
            marks,
            meeting
          );
          pos += cell.length + 1;
          return header ? <th key={j}>{value}</th> : <td key={j}>{value}</td>;
        });
      };

      nodes.push(
        <table key={i}>
          <thead>
            <tr>{cells(rows[0], true)}</tr>
          </thead>
          <tbody>
            {rows.slice(1).map((row, j) => (
              <tr key={j}>{cells(row, false)}</tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)/),
      list = line.match(/^\s*[-*]\s+/);
    if (h) {
      const Tag = `h${h[1].length}` as 'h1' | 'h2' | 'h3';
      nodes.push(
        <Tag key={i}>{inline(h[2], starts[i] + line.length - h[2].length, marks, meeting)}</Tag>
      );
    } else if (list)
      nodes.push(
        <p key={i}>
          • {inline(line.slice(list[0].length), starts[i] + list[0].length, marks, meeting)}
        </p>
      );
    else nodes.push(<p key={i}>{line ? inline(line, starts[i], marks, meeting) : <br />}</p>);
  }
  return nodes;
}
