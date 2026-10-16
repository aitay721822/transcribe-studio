import { record } from '../../domain/value';

export interface CredentialStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  getSelectedStorageBackend(): string;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
export interface SettingsProtection {
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
  migrate(value: string): Promise<string | null>;
}

const PREFIX = 'protected-settings:v2:';

/** Protect the complete settings document so custom fields cannot bypass credential encryption. */
export function credentialProtection(
  storage: CredentialStorage,
  platform: NodeJS.Platform
): SettingsProtection {
  let rotate = false;

  async function available() {
    if (!(await storage.isAsyncEncryptionAvailable()))
      throw new Error('作業系統憑證加密不可用，無法讀寫秘密設定');
    if (platform === 'linux') {
      const backend = storage.getSelectedStorageBackend();
      if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend))
        throw new Error('請先啟用系統金鑰圈；不允許使用 basic_text 儲存憑證');
    }
  }

  async function decrypt(value: string) {
    await available();
    try {
      const decrypted = await storage.decryptStringAsync(Buffer.from(value, 'base64'));
      rotate ||= decrypted.shouldReEncrypt;
      return decrypted.result;
    } catch {
      throw new Error('無法解密憑證設定，請使用原作業系統帳戶與金鑰圈；原始資料已保留');
    }
  }

  async function protect(value: string) {
    await available();
    try {
      return `${PREFIX}${(await storage.encryptStringAsync(value)).toString('base64')}`;
    } catch {
      throw new Error('憑證設定加密失敗，未寫入明文');
    }
  }

  function parse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('憑證設定格式損毀，原始資料已保留');
    }
  }

  async function unprotect(value: string) {
    const sealed = value.startsWith(PREFIX);
    const settings = record(parse(sealed ? await decrypt(value.slice(PREFIX.length)) : value));
    if (!Object.keys(record(settings.llm)).length || !Object.keys(record(settings.asr)).length)
      throw new Error('憑證設定格式損毀，原始資料已保留');
    if (sealed) return JSON.stringify(settings);
    // Older versions encrypted only selected values. Decode before sealing the whole document.
    for (const section of ['llm', 'asr']) {
      const fields = record(settings[section]);
      for (const name of [
        'apiKey',
        'claudeKey',
        'fileApiKey',
        'headers',
        'fileHeaders',
        'iceServers',
      ]) {
        const field = fields[name];
        if (typeof field !== 'string' || !field.startsWith('encrypted:')) continue;
        const plain = await decrypt(field.slice(10));
        fields[name] = ['headers', 'fileHeaders', 'iceServers'].includes(name)
          ? parse(plain)
          : plain;
      }
    }
    if (typeof settings.mcp === 'string') {
      const plain = settings.mcp.startsWith('encrypted:')
        ? await decrypt(settings.mcp.slice(10))
        : settings.mcp;
      settings.mcp = parse(plain);
    }
    return JSON.stringify(settings);
  }

  async function migrate(value: string) {
    rotate = false;
    const plain = await unprotect(value);
    if (value.startsWith(PREFIX) && !rotate) return null;
    return protect(plain);
  }

  return { protect, unprotect, migrate };
}
