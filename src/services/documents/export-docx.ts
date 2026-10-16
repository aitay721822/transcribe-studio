import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { Meeting } from '../../domain/models';

function inline(text: string) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map(
      (s) =>
        new TextRun({ text: s.startsWith('**') ? s.slice(2, -2) : s, bold: s.startsWith('**') })
    );
}

function markdownBlocks(text: string) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('|') && lines[i + 1]?.match(/^\s*\|?\s*:?-{3}/)) {
      const rows = [line];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      i--;
      blocks.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map(
            (r, j) =>
              new TableRow({
                children: r
                  .trim()
                  .replace(/^\||\|$/g, '')
                  .split('|')
                  .map(
                    (cell) =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: inline(cell.trim()),
                            ...(j === 0 ? { style: 'Heading3' } : {}),
                          }),
                        ],
                      })
                  ),
              })
          ),
        })
      );
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)/);
    if (h)
      blocks.push(
        new Paragraph({
          children: inline(h[2]),
          heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
            h[1].length - 1
          ],
        })
      );
    else if (/^\s*[-*]\s+/.test(line))
      blocks.push(
        new Paragraph({ children: inline(line.replace(/^\s*[-*]\s+/, '')), bullet: { level: 0 } })
      );
    else blocks.push(new Paragraph({ children: inline(line), spacing: { after: 140 } }));
  }
  return blocks;
}

async function exportDocx(meeting: Meeting, transcript = false) {
  const children = [
    new Paragraph({ text: meeting.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      text: new Date(meeting.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      spacing: { after: 300 },
    }),
    ...markdownBlocks(meeting.notes),
  ];
  if (transcript) {
    children.push(
      new Paragraph({ text: '逐字稿附錄', heading: HeadingLevel.HEADING_1, pageBreakBefore: true })
    );
    for (const s of meeting.segments)
      children.push(
        new Paragraph({
          text: `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}] ${s.speaker || ''} ${s.text}`,
        })
      );
  }
  return Packer.toBuffer(
    new Document({
      creator: 'Transcribe Studio',
      title: meeting.title,
      styles: {
        default: {
          document: {
            run: { font: 'Microsoft JhengHei', size: 22 },
            paragraph: { spacing: { line: 320 } },
          },
        },
      },
      sections: [{ properties: {}, children }],
    })
  );
}

export { exportDocx, markdownBlocks };
