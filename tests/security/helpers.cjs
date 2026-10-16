const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { Store, DEFAULTS } = require('../../dist/persistence/store.cjs');

function keychain() {
  const key = randomBytes(32);
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,

    isAsyncEncryptionAvailable: async () => true,

    getSelectedStorageBackend: () => 'gnome_libsecret',

    async encryptStringAsync(value) {
      calls.encrypt++;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },

    async decryptStringAsync(value) {
      calls.decrypt++;
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      const plain = Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(
        'utf8'
      );
      return { result: plain, shouldReEncrypt: false };
    },
  };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-credential-policy-'));
  const filename = path.join(directory, 'studio.sqlite');
  const store = new Store(filename);
  t.after(() => {
    store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('studio-credential-policy-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const settings = structuredClone(DEFAULTS);
  settings.llm.apiKey = 'fixture-model-secret';
  settings.llm.claudeKey = 'fixture-claude-secret';
  settings.llm.baseUrl = 'https://model.invalid/v1?api_key=fixture-url-secret';
  settings.asr.fileApiKey = 'fixture-file-secret';
  settings.asr.headers = { Authorization: 'Bearer fixture-header-secret' };
  settings.asr.init = { nested: { token: 'fixture-init-secret' } };
  settings.asr.audioEnvelope = { credential: 'fixture-envelope-secret' };
  settings.asr.iceServers = [{ urls: 'turn:turn.invalid', credential: 'fixture-turn-secret' }];
  settings.mcp = [
    {
      name: 'remote',
      transport: 'stdio',
      command: 'fixture',
      enabled: false,
      args: ['--api-key', 'fixture-argument-secret'],
      env: { ACCESS_TOKEN: 'fixture-environment-secret' },
      headers: { 'X-Custom-Auth': 'fixture-custom-secret' },
    },
  ];
  return { directory, filename, settings, store };
}

module.exports = { fixture, keychain };
