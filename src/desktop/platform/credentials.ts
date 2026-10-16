import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dialog, safeStorage } from 'electron';
import { errorMessage } from '../../domain/value';
import type { Store } from '../../persistence/store';
import { credentialProtection } from '../../services/security/credentials';
import { resetCredentialSettings } from '../../services/security/recovery';
import { SettingsVault } from '../../services/security/settings';

export class CredentialStartupCancelled extends Error {}

export async function openCredentialVault(store: Store, dataDir: string) {
  const protection = credentialProtection(safeStorage, process.platform);
  let failure: unknown;
  for (;;) {
    try {
      return await SettingsVault.open(store, protection);
    } catch (error) {
      failure = error;
    }
    const resettable = store.settingsRecord()?.startsWith('protected-settings:v2:');
    const buttons = ['重試', '結束'];
    if (resettable) buttons.push('保留舊設定並重新設定憑證');
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '憑證設定無法解密',
      message: errorMessage(failure),
      detail: '請先解鎖系統金鑰圈或允許此應用程式存取。從其他電腦搬來的加密憑證需要重新設定。',
      buttons,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 1) throw new CredentialStartupCancelled();
    if (result.response !== 2 || !resettable) continue;
    const confirm = await dialog.showMessageBox({
      type: 'warning',
      title: '重新設定服務憑證',
      message: '舊加密設定會另存備份，服務設定需重新輸入；會議、筆記與錄音會保留。',
      buttons: ['取消', '備份並重新設定'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirm.response !== 1) continue;
    try {
      await resetCredentialSettings(store, protection, async (ciphertext) => {
        const file = path.join(dataDir, `locked-settings-${randomUUID()}.enc`);
        const handle = await fs.open(file, 'wx', 0o600);
        try {
          await handle.writeFile(ciphertext);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        message: errorMessage(error),
        detail: '原始設定仍保留，請先排除金鑰圈或磁碟問題。',
      });
    }
  }
}
