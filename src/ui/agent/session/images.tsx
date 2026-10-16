import type { ImageAttachment, Meeting, UiState } from '../../../domain/models';
import { notify } from '../../layout/notifications';
import { invalidateUI } from '../../layout/roots';
import { Button } from '../../primitives/button';

export const imageUrl = (meetingId: string, image: ImageAttachment) =>
  `studio-media://image/${meetingId}/${image.id}`;

export async function addImages(state: UiState, meetingId: string, files: File[]) {
  const sessionId = state.temporaryChat?.id;
  state.imageDrafts ||= {};
  for (const file of files) {
    if ((state.imageDrafts[meetingId]?.length || 0) >= 8) throw new Error('每則訊息最多 8 張圖片');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))
      throw new Error('支援 PNG、JPEG、WebP、GIF 圖片');
    if (file.size > 10 * 1024 * 1024) throw new Error('單張圖片最多 10 MB');
    const image = await window.studio.invoke(
      'agent:image-add',
      meetingId,
      file.name,
      new Uint8Array(await file.arrayBuffer()),
      sessionId
    );
    if (state.meetingId !== meetingId || state.temporaryChat?.id !== sessionId) {
      void window.studio.invoke('agent:image-release', image.id);
      continue;
    }
    state.imageDrafts[meetingId] = [...(state.imageDrafts[meetingId] || []), image];
    invalidateUI();
  }
}

export function ImageAttachments({ state, meeting }: { state: UiState; meeting: Meeting }) {
  const images = state.imageDrafts?.[meeting.id] || [];
  return images.length ? (
    <div className="image-attachments" aria-label="待送出的圖片">
      {images.map((image) => (
        <div className="image-attachment" key={image.id}>
          <img src={imageUrl(meeting.id, image)} alt={image.name} title={image.name} />
          <Button
            variant="ghost"
            size="bare"
            type="button"
            aria-label={`移除圖片 ${image.name}`}
            onClick={() => {
              state.imageDrafts[meeting.id] = images.filter((i) => i.id !== image.id);
              void window.studio.invoke('agent:image-release', image.id).catch(() => {});
              invalidateUI();
            }}
          >
            ×
          </Button>
        </div>
      ))}
    </div>
  ) : null;
}

export function ImagePicker({ state, meeting }: { state: UiState; meeting: Meeting }) {
  return (
    <input
      id="agent-image-picker"
      className="sr-only"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      tabIndex={-1}
      aria-label="選擇圖片附件"
      onChange={async (event) => {
        const files = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = '';
        try {
          await addImages(state, meeting.id, files);
        } catch (caughtE) {
          const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

          notify(e.message, true);
        }
      }}
    />
  );
}
