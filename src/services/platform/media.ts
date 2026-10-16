import type { MediaPermissions } from '../../domain/platform';
import { permissionMessage, systemAudioAvailable } from '../../domain/platform';

export interface MediaPermissionPort {
  platform: string;
  release: string;
  status(kind: 'microphone' | 'screen'): string;
  requestMicrophone(): Promise<boolean>;
  openSettings(kind: 'microphone' | 'screen'): Promise<void>;
}

export function mediaPermissions(port: MediaPermissionPort) {
  function status(): MediaPermissions {
    const supported = systemAudioAvailable(port.platform, port.release);
    return {
      platform: port.platform,
      microphone: port.status('microphone'),
      screen: port.status('screen'),
      systemAudio: supported,
      systemAudioReason: supported
        ? undefined
        : '此系統版本尚未支援原生系統音訊擷取，請選擇麥克風或虛擬音訊輸入裝置',
    };
  }

  async function prepare(source: string) {
    if (!['mic', 'system', 'both'].includes(source)) throw new Error('無效的音訊來源');
    const current = status();
    if (source !== 'mic' && !current.systemAudio) throw new Error(current.systemAudioReason);
    if (port.platform !== 'darwin') return current;
    if (source !== 'system') {
      let permission = current.microphone;
      if (permission === 'not-determined')
        permission = (await port.requestMicrophone()) ? 'granted' : 'denied';
      if (permission !== 'granted') throw new Error(permissionMessage('microphone', permission));
    }
    if (source !== 'mic' && ['denied', 'restricted'].includes(current.screen))
      throw new Error(permissionMessage('screen', current.screen));
    return status();
  }

  return { status, prepare, openSettings: port.openSettings };
}
