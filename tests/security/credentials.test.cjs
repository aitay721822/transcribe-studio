const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS } = require('../../dist/persistence/store.cjs');
const { credentialProtection } = require('../../dist/services/security/credentials.cjs');
const { SettingsVault } = require('../../dist/services/security/settings.cjs');
const { credentialRedactor } = require('../../dist/services/security/redaction.cjs');
const { resetCredentialSettings } = require('../../dist/services/security/recovery.cjs');
const { fixture, keychain } = require('./helpers.cjs');

function assertNoPlaintext(directory) {
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith('studio.sqlite')) continue;
    assert.equal(
      fs.readFileSync(path.join(directory, entry)).includes(Buffer.from('fixture-')),
      false
    );
  }
}

test('async vault encrypts all settings, preserves snapshots and survives reopening', async (t) => {
  const { store, settings, directory } = fixture(t);
  const storage = keychain();
  const protection = credentialProtection(storage, 'darwin');
  const vault = await SettingsVault.open(store, protection);
  await vault.save(settings);
  assert.match(store.settingsRecord(), /^protected-settings:v2:/);
  assert.deepEqual(vault.read(), settings);
  const reopened = await SettingsVault.open(store, protection);
  assert.deepEqual(reopened.read(), settings);
  const decryptCount = storage.calls.decrypt;
  reopened.read().llm.apiKey = 'mutated';
  assert.deepEqual(reopened.read(), settings);
  assert.equal(storage.calls.decrypt, decryptCount, 'ordinary reads never touch the OS keychain');
  assertNoPlaintext(directory);
});

test('plaintext and legacy field-encrypted settings migrate without SQLite/WAL remnants', async (t) => {
  const { store, settings, directory } = fixture(t);
  const storage = keychain();
  const legacy = structuredClone(settings);
  legacy.llm.apiKey = `encrypted:${(await storage.encryptStringAsync(settings.llm.apiKey)).toString('base64')}`;
  legacy.asr.headers = `encrypted:${(await storage.encryptStringAsync(JSON.stringify(settings.asr.headers))).toString('base64')}`;
  legacy.mcp = `encrypted:${(await storage.encryptStringAsync(JSON.stringify(settings.mcp))).toString('base64')}`;
  store.saveSettings(legacy);
  const protection = credentialProtection(storage, 'win32');
  const vault = await SettingsVault.open(store, protection);
  assert.deepEqual(vault.read(), settings);
  assertNoPlaintext(directory);
  const ciphertext = store.settingsRecord();
  await SettingsVault.open(store, protection);
  assert.equal(store.settingsRecord(), ciphertext, 'migration is idempotent');
});

test('wrong account, unavailable keychain and insecure Linux backends fail closed', async (t) => {
  const { store, settings } = fixture(t);
  const unavailable = {
    ...keychain(),

    isAsyncEncryptionAvailable: async () => false,
  };
  const empty = await SettingsVault.open(store, credentialProtection(unavailable, 'win32'));
  await assert.rejects(empty.save(settings), /憑證加密不可用/);
  assert.equal(store.settingsRecord(), undefined);
  assert.deepEqual(empty.read(), DEFAULTS);
  for (const backend of ['basic_text', 'unknown']) {
    const protection = credentialProtection(
      {
        ...keychain(),

        getSelectedStorageBackend: () => backend,
      },
      'linux'
    );
    await assert.rejects(protection.protect(JSON.stringify(settings)), /不允許/);
  }
  const vault = await SettingsVault.open(store, credentialProtection(keychain(), 'darwin'));
  await vault.save(settings);
  const before = store.settingsRecord();
  await assert.rejects(
    SettingsVault.open(store, credentialProtection(keychain(), 'darwin')),
    /原始資料已保留/
  );
  assert.equal(store.settingsRecord(), before);
});

test('failed migration, malformed records and encryption errors retain original data', async (t) => {
  const { store, settings } = fixture(t);
  store.saveSettings(settings);
  const before = store.settingsRecord();
  const unavailable = credentialProtection(
    {
      ...keychain(),

      isAsyncEncryptionAvailable: async () => false,
    },
    'darwin'
  );
  await assert.rejects(SettingsVault.open(store, unavailable), /憑證加密不可用/);
  assert.equal(store.settingsRecord(), before);
  const storage = keychain();
  const protection = credentialProtection(storage, 'darwin');
  await assert.rejects(protection.unprotect(`{"apiKey":"${settings.llm.apiKey}`), (error) => {
    assert.match(error.message, /格式損毀/);
    assert.equal(error.message.includes(settings.llm.apiKey), false);
    return true;
  });
  const vault = await SettingsVault.open(store, protection);
  const encrypted = store.settingsRecord();
  storage.encryptStringAsync = async () => {
    throw new Error(settings.llm.apiKey);
  };
  await assert.rejects(
    vault.save(settings),
    (error) => /未寫入明文/.test(error.message) && !error.message.includes(settings.llm.apiKey)
  );
  assert.equal(store.settingsRecord(), encrypted);
  assert.deepEqual(vault.read(), settings);
});

test('async saves are serialized, fail atomically and continue after a rejected save', async (t) => {
  const { store, settings } = fixture(t);
  const storage = keychain();
  const encrypt = storage.encryptStringAsync;
  let release;
  storage.encryptStringAsync = async (value) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return encrypt(value);
  };
  const vault = await SettingsVault.open(store, credentialProtection(storage, 'darwin'));
  const first = vault.save(settings);
  const secondSettings = { ...settings, theme: 'dark' };
  const second = vault.save(secondSettings);
  await new Promise(setImmediate);
  assert.equal(store.settingsRecord(), undefined);
  assert.deepEqual(vault.read(), DEFAULTS);
  release();
  await first;
  await new Promise(setImmediate);
  assert.equal(vault.read().theme, settings.theme);
  release();
  await second;
  assert.equal(vault.read().theme, 'dark');
  storage.encryptStringAsync = async () => {
    throw new Error('failure');
  };
  await assert.rejects(vault.save(settings));
  assert.equal(vault.read().theme, 'dark');
  storage.encryptStringAsync = encrypt;
  await vault.save(settings);
  await vault.flush();
  assert.deepEqual(vault.read(), settings);
});

test('key rotation rewrites ciphertext without changing settings', async (t) => {
  const { store, settings } = fixture(t);
  const storage = keychain();
  await (await SettingsVault.open(store, credentialProtection(storage, 'darwin'))).save(settings);
  const previous = store.settingsRecord();
  const decrypt = storage.decryptStringAsync;
  let rotate = true;
  storage.decryptStringAsync = async (value) => {
    const result = await decrypt(value);
    const shouldReEncrypt = rotate;
    rotate = false;
    return { ...result, shouldReEncrypt };
  };
  const restored = await SettingsVault.open(store, credentialProtection(storage, 'darwin'));
  assert.deepEqual(restored.read(), settings);
  assert.notEqual(store.settingsRecord(), previous);
});

test('credential recovery backs up ciphertext before reset, preserves meetings and aborts on backup failure', async (t) => {
  const { store, settings } = fixture(t);
  const project = store.createProject('keep');
  const meeting = store.createMeeting(project.id, 'keep');
  const protection = credentialProtection(keychain(), 'darwin');
  await (await SettingsVault.open(store, protection)).save(settings);
  const old = store.settingsRecord();
  await assert.rejects(
    resetCredentialSettings(store, protection, async () => {
      throw new Error('disk full');
    }),
    /disk full/
  );
  assert.equal(store.settingsRecord(), old);
  let backup;
  await resetCredentialSettings(store, protection, async (ciphertext) => {
    backup = ciphertext;
  });
  assert.equal(backup, old);
  assert.deepEqual((await SettingsVault.open(store, protection)).read(), DEFAULTS);
  assert.equal(store.get('meetings', meeting.id).title, 'keep');
  assert.deepEqual(JSON.parse(await protection.unprotect(backup)), settings);
});

test('diagnostics mask nested, encoded, MCP and inherited credentials while preserving trace data', (t) => {
  const { settings } = fixture(t);
  const redact = credentialRedactor(settings, { CUSTOM_ACCESS_TOKEN: 'fixture-inherited-secret' });
  const result = redact.value({
    arguments: { token: 'short', page: 3 },
    output: [JSON.stringify(settings), 'fixture-inherited-secret', 'Bearer unknownToken0123456789'],
    error: 'https://service.invalid?access_token=unknown-query-secret',
    normal: '逐字稿 offset 120',
  });
  assert.equal(result.arguments.page, 3);
  assert.equal(result.arguments.token, '••••••••');
  assert.equal(result.normal, '逐字稿 offset 120');
  for (const fragment of ['fixture-', 'unknownToken', 'unknown-query-secret'])
    assert.equal(JSON.stringify(result).includes(fragment), false);
  assert.equal(redact.text(encodeURIComponent(settings.asr.headers.Authorization)), '••••••••');
});
