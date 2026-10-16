import type { InputDevice } from '../../domain/audio-devices';
import { inputDeviceCatalog } from '../../domain/audio-devices';
import { openPlaybackStream } from './devices/playback-stream';

export type { InputDevice } from '../../domain/audio-devices';

export async function listInputDevices(requestPermission = false): Promise<InputDevice[]> {
  let stream: MediaStream | undefined;
  try {
    if (requestPermission) {
      if (typeof window !== 'undefined') await window.studio?.invoke('media:prepare', 'mic');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    const track = stream?.getAudioTracks()[0];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return inputDeviceCatalog(
      devices,
      track ? { deviceId: track.getSettings().deviceId, label: track.label } : undefined
    );
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export async function openAudioSources(
  source: string,
  microphoneId = '',
  playbackId = ''
): Promise<MediaStream[]> {
  if (!['mic', 'system', 'both'].includes(source))
    throw new Error('請至少選擇一個播放裝置或麥克風');
  const streams: MediaStream[] = [];
  try {
    if (typeof window !== 'undefined') await window.studio?.invoke('media:prepare', source);
    if (source !== 'mic') {
      const nativePlayback =
        typeof document !== 'undefined' && document.documentElement.dataset.platform === 'win32';
      if (playbackId && !nativePlayback) throw new Error('此平台尚未支援指定播放裝置擷取');
      const system = nativePlayback
        ? await openPlaybackStream(playbackId)
        : await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: { width: 320, height: 180, frameRate: 1 },
          });
      streams.push(system);
      if (!system.getAudioTracks().length) throw new Error('沒有取得系統音訊，請確認音訊擷取權限');
      if (system.getAudioTracks().every((track) => track.readyState === 'ended'))
        throw new Error('系統音訊串流已結束，請重新選擇來源並檢查系統錄音權限');
    }
    if (source !== 'system')
      streams.push(
        await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        })
      );
    return streams;
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));

    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    throw error;
  }
}
