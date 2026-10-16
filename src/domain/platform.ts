export interface MediaPermissions {
  platform: string;
  microphone: string;
  screen: string;
  systemAudio: boolean;
  systemAudioReason?: string;
}

export function systemAudioAvailable(platform: string, darwinRelease: string): boolean {
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  const [major, minor] = darwinRelease.split('.').map(Number);
  // macOS 14.2 corresponds to Darwin 23.2; this is the verified CoreAudio Tap path.
  return major > 23 || (major === 23 && minor >= 2);
}

export function permissionMessage(kind: 'microphone' | 'screen', state: string) {
  const label = kind === 'microphone' ? '麥克風' : '螢幕與系統音訊錄製';
  if (state === 'restricted') return `${label}受到系統或管理政策限制`;
  return `請在系統設定的「隱私權與安全性」允許${label}，變更後重新啟動應用程式`;
}
