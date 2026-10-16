import { open } from 'node:fs/promises';
import path from 'node:path';

const audioTypes: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
};

/** Serve an already-authorized recording with byte ranges so Chromium can seek reliably. */
export async function recordingResponse(request: Request, filename: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const file = await open(filename, 'r').catch((): null => null);
  if (!file) return new Response(null, { status: 404 });
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    await file.close();
  }

  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      await close();
      return new Response(null, { status: 404 });
    }
    const size = stats.size;
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type':
        audioTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    let start = 0;
    let end = size - 1;
    const range = request.method === 'GET' ? request.headers.get('range') : null;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let valid = !!match && !!(match[1] || match[2]) && size > 0;
      if (match && valid) {
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        } else {
          const suffix = Number(match[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, size - suffix);
        }
        valid =
          valid &&
          Number.isSafeInteger(start) &&
          Number.isSafeInteger(end) &&
          start <= end &&
          start < size;
      }
      if (!valid) {
        await close();
        headers.set('Content-Range', `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    const status = range ? 206 : 200;
    if (request.method === 'HEAD' || !size) {
      await close();
      return new Response(null, { status, headers });
    }
    let position = start;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = new Uint8Array(Math.min(65536, end - position + 1));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (closed) return;
          if (!bytesRead) throw new Error('Recording changed during playback');
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
          if (position > end) {
            controller.close();
            await close();
          }
        } catch (error) {
          controller.error(error);
          await close();
        }
      },

      cancel: close,
    });
    return new Response(body, { status, headers });
  } catch {
    await close();
    return new Response(null, { status: 404 });
  }
}
