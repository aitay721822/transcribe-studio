import type { Store } from '../../persistence/store';
import { DEFAULTS } from '../../persistence/store';
import type { SettingsProtection } from './credentials';

/** A reset is committed only after encryption succeeds and the old ciphertext is durably backed up. */
export async function resetCredentialSettings(
  store: Pick<Store, 'settingsRecord' | 'saveSettingsRecord'>,
  protection: SettingsProtection,
  backup: (ciphertext: string) => Promise<void>
) {
  const previous = store.settingsRecord();
  if (!previous?.startsWith('protected-settings:v2:'))
    throw new Error('只能重新設定已加密的憑證資料');
  const replacement = await protection.protect(JSON.stringify(DEFAULTS));
  await backup(previous);
  store.saveSettingsRecord(replacement, true);
}
