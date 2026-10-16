import yauzl from 'yauzl';

// Only extract the main document XML. Never evaluate DTDs or external relationships.
function extractDocx(filename: string) {
  return new Promise<string>((resolve, reject) => {
    yauzl.open(
      filename,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(error);
        let found = false;
        zip.on('error', reject);
        zip.on('end', () => {
          if (!found) reject(new Error('DOCX 缺少 word/document.xml'));
        });
        zip.on('entry', (entry) => {
          if (entry.fileName !== 'word/document.xml') {
            zip.readEntry();
            return;
          }
          found = true;
          if (entry.uncompressedSize > 4 * 1024 * 1024) {
            zip.close();
            reject(new Error('DOCX 解壓縮內容過大'));
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error) {
              zip.close();
              reject(error);
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on('error', (e) => {
              zip.close();
              reject(e);
            });
            stream.on('data', (b: Buffer) => {
              bytes += b.length;
              if (bytes > 4 * 1024 * 1024) {
                stream.destroy(new Error('DOCX 解壓縮內容過大'));
                return;
              }
              chunks.push(b);
            });
            stream.on('end', () => {
              zip.close();
              const xml = Buffer.concat(chunks).toString('utf8');
              const text = xml
                .replace(/<w:tab\b[^>]*\/>/g, '\t')
                .replace(/<w:br\b[^>]*\/>/g, '\n')
                .replace(/<\/w:p>/g, '\n')
                .replace(/<\/w:tc>/g, '\t')
                .replace(/<[^>]+>/g, '')
                .replace(
                  /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
                  (all: string, name: string) => {
                    const entities: Record<string, string> = {
                      amp: '&',
                      lt: '<',
                      gt: '>',
                      quot: '"',
                      apos: "'",
                    };
                    if (name.startsWith('#')) {
                      const code =
                        name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
                      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
                    }
                    return entities[name] || all;
                  }
                );
              resolve(text.trim());
            });
          });
        });
        zip.readEntry();
      }
    );
  });
}

export { extractDocx };
