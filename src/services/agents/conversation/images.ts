import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRequest, ImageAttachment, ImageData } from '../../../domain/models';

const valid = (id: string) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);

export class ImageVault {
  private cache = new Map<string, { image: ImageData; meetingId: string; sessionId?: string }>();

  constructor(
    private directory: string,
    private normalize: (bytes: Buffer) => { bytes: Buffer; width: number; height: number }
  ) {}

  add(meetingId: string, name: string, bytes: Uint8Array, sessionId?: string) {
    if (
      !valid(meetingId) ||
      (sessionId && !valid(sessionId)) ||
      !bytes?.length ||
      bytes.length > 10 * 1024 * 1024
    )
      throw new Error('圖片最多 10 MB');
    if (this.cache.size >= 64) throw new Error('圖片暫存已滿，請移除未送出的圖片');
    const result = this.normalize(Buffer.from(bytes));
    if (result.bytes.length > 4 * 1024 * 1024) throw new Error('轉換後的圖片超過 4 MB，請縮小圖片');
    const image: ImageData = {
      id: randomUUID(),
      name: String(name || '圖片.png').slice(0, 200),
      mime: 'image/png',
      width: result.width,
      height: result.height,
      dataUrl: `data:image/png;base64,${result.bytes.toString('base64')}`,
    };
    this.cache.set(image.id, { image, meetingId, sessionId });
    const { dataUrl, ...metadata } = image;
    return metadata;
  }

  private filename(meetingId: string, id: string) {
    if (!valid(meetingId) || !valid(id)) throw new Error('圖片代碼無效');
    return path.join(this.directory, meetingId, `${id}.png`);
  }

  async load(
    request: Pick<AgentRequest, 'meetingId' | 'images' | 'sessionId'>
  ): Promise<ImageData[]> {
    if (!Array.isArray(request.images || []) || (request.images?.length || 0) > 8)
      throw new Error('每則訊息最多 8 張圖片');
    const images = await Promise.all(
      (request.images || []).map(async (metadata) => {
        const cached = this.cache.get(metadata.id);
        if (cached) {
          if (cached.meetingId !== request.meetingId || cached.sessionId !== request.sessionId)
            throw new Error('圖片不屬於此對話');
          return cached.image;
        }
        if (request.sessionId) throw new Error('暫時圖片已清除');
        const bytes = await fs.readFile(this.filename(request.meetingId, metadata.id));
        if (bytes.length > 4 * 1024 * 1024) throw new Error('圖片過大');
        return { ...metadata, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
      })
    );
    if (
      images.reduce(
        (bytes, image) => bytes + Buffer.byteLength(image.dataUrl.split(',')[1], 'base64'),
        0
      ) >
      5 * 1024 * 1024
    )
      throw new Error('每則訊息的圖片轉換後總量最多 5 MB，請移除部分圖片');
    return images;
  }

  async prepare(request: AgentRequest) {
    const images = await this.load(request);
    request.images = images.map(({ dataUrl, ...metadata }) => metadata);
    if (!request.sessionId && images.length) {
      await fs.mkdir(path.join(this.directory, request.meetingId), { recursive: true });
      for (const image of images)
        await fs.writeFile(
          this.filename(request.meetingId, image.id),
          Buffer.from(image.dataUrl.split(',')[1], 'base64')
        );
      for (const image of images) this.cache.delete(image.id);
    }
  }

  release(id: string) {
    this.cache.delete(id);
  }

  clearSession(sessionId: string) {
    for (const [id, entry] of this.cache) if (entry.sessionId === sessionId) this.cache.delete(id);
  }

  async bytes(meetingId: string, id: string) {
    return Buffer.from(
      (
        await this.load({
          meetingId,
          images: [{ id } as ImageAttachment],
          sessionId: this.cache.get(id)?.sessionId,
        })
      )[0].dataUrl.split(',')[1],
      'base64'
    );
  }
}
