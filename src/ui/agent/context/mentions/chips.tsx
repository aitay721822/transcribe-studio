import type { ContextReference, Meeting, UiState } from '../../../../domain/models';
import { invalidateUI } from '../../../layout/roots';

export function referenceDrafts(state: UiState, meeting: Meeting): ContextReference[] {
  state.referenceDrafts ||= {};
  return (state.referenceDrafts[meeting.id] ||= (meeting.references || []).map((r) => ({
    ...r,
    kind: 'file',
  })));
}

export const referenceKey = (r: ContextReference) =>
  r.kind === 'search' ? `search:${r.query}` : `${r.kind}:${r.rootId}:${r.relative}`;

export const referenceLabel = (r: ContextReference) =>
  r.kind === 'search'
    ? `搜尋：${r.query}`
    : `${r.kind === 'directory' ? '資料夾：' : '文件：'}${r.rootName}/${r.relative}`;

export function SentReferences({ references }: { references?: ContextReference[] }) {
  return references?.length ? (
    <div className="reference-chips sent-references" aria-label="此訊息指定的來源">
      {references.map((r) => (
        <span className="reference-chip" title={referenceLabel(r)} key={referenceKey(r)}>
          <span>{referenceLabel(r)}</span>
        </span>
      ))}
    </div>
  ) : null;
}

export function ReferenceChips({ state, meeting }: { state: UiState; meeting: Meeting }) {
  const refs = referenceDrafts(state, meeting);
  return refs.length ? (
    <div className="reference-chips" aria-label="本則訊息的參考來源">
      {refs.map((r) => {
        const label = referenceLabel(r);
        return (
          <span className="reference-chip" key={referenceKey(r)} title={label}>
            <span>{label}</span>
            <button
              type="button"
              aria-label={`移除${label}`}
              onClick={() => {
                state.referenceDrafts[meeting.id] = refs.filter(
                  (item) => referenceKey(item) !== referenceKey(r)
                );
                invalidateUI();
              }}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  ) : null;
}
