import os from 'node:os';
import { shell, systemPreferences } from 'electron';
import { mediaPermissions } from '../../services/platform/media';

export const mediaAccess = mediaPermissions({
  platform: process.platform,
  release: os.release(),

  status: (kind) => {
    if (!['darwin', 'win32'].includes(process.platform)) return 'unknown';
    return systemPreferences.getMediaAccessStatus(kind);
  },

  requestMicrophone: () => systemPreferences.askForMediaAccess('microphone'),

  openSettings: async (kind) => {
    if (kind !== 'microphone' && kind !== 'screen') throw new Error('無效的權限類型');
    if (process.platform === 'darwin')
      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?Privacy_${kind === 'microphone' ? 'Microphone' : 'ScreenCapture'}`
      );
    else if (process.platform === 'win32')
      await shell.openExternal('ms-settings:privacy-microphone');
  },
});
