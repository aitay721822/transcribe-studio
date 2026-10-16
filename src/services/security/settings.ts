import type { Settings } from '../../domain/models';
import type { Store } from '../../persistence/store';
import { DEFAULTS } from '../../persistence/store';
import type { SettingsProtection } from './credentials';

/** Decrypt once at startup; reads never prompt the OS keychain or block the main thread. */
export class SettingsVault {
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private store: Pick<Store, 'saveSettingsRecord'>,
    private protection: SettingsProtection,
    private snapshot: Settings
  ) {}

  static async open(
    store: Pick<Store, 'settingsRecord' | 'saveSettingsRecord'>,
    protection: SettingsProtection
  ) {
    const record = store.settingsRecord();
    if (!record) return new SettingsVault(store, protection, structuredClone(DEFAULTS));
    const migrated = await protection.migrate(record);
    const snapshot: Settings = JSON.parse(await protection.unprotect(migrated || record));
    if (migrated) store.saveSettingsRecord(migrated, true);
    return new SettingsVault(store, protection, snapshot);
  }

  read(): Settings {
    return structuredClone(this.snapshot);
  }

  save(settings: Settings): Promise<void> {
    const next = structuredClone(settings);
    const operation = this.pending.then(async () => {
      const encrypted = await this.protection.protect(JSON.stringify(next));
      this.store.saveSettingsRecord(encrypted);
      this.snapshot = next;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  flush() {
    return this.pending;
  }
}
