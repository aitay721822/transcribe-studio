import { useEffect, useState } from 'react';
import type { PlaybackDevice } from '../../../domain/audio-devices';

export function usePlaybackDevices(busy: boolean) {
  const [devices, setDevices] = useState<PlaybackDevice[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      if (busy) return;
      try {
        const value = await window.studio.invoke('media:playback-devices');
        if (alive) {
          setDevices(value);
          setError('');
        }
      } catch (error) {
        if (alive) setError(error instanceof Error ? error.message : '無法取得播放裝置');
      } finally {
        if (alive) setLoading(false);
      }
    };

    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [busy]);
  return { devices, error, loading };
}
