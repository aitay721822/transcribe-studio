import { useEffect, useState } from 'react';
import type { MediaPermissions } from '../../../domain/platform';

export function useMediaPermissions() {
  const [permissions, setPermissions] = useState<MediaPermissions>();
  useEffect(() => {
    let alive = true;

    const refresh = () => {
      void window.studio
        ?.invoke('media:status')
        .then((value) => {
          if (alive) setPermissions(value);
        })
        .catch(() => {});
    };

    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return permissions;
}

export function AudioPermissions({ permissions }: { permissions?: MediaPermissions }) {
  const [error, setError] = useState('');
  if (permissions?.platform !== 'darwin') return null;
  if (
    permissions.systemAudio &&
    !['denied', 'restricted'].includes(permissions.microphone) &&
    !['denied', 'restricted'].includes(permissions.screen) &&
    !error
  )
    return null;

  async function open(kind: 'microphone' | 'screen') {
    try {
      await window.studio.invoke('media:settings', kind);
    } catch {
      setError('無法開啟系統設定，請手動開啟「隱私權與安全性」。');
    }
  }

  return (
    <div className="help" role="status" aria-label="系統錄音權限">
      {!permissions.systemAudio && <p>{permissions.systemAudioReason}</p>}
      {(['microphone', 'screen'] as const).map(
        (kind) =>
          ['denied', 'restricted'].includes(permissions[kind]) && (
            <p key={kind}>
              {kind === 'microphone' ? '麥克風' : '螢幕與系統音訊'}權限未開啟。
              <button type="button" className="btn text small" onClick={() => void open(kind)}>
                開啟系統設定
              </button>
            </p>
          )
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
