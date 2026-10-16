const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { Store, DEFAULTS } = require('../../../dist/persistence/store.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-credential-ui-'));
  const filename = path.join(profile, 'studio.sqlite');
  const settings = structuredClone(DEFAULTS);
  settings.llm.apiKey = 'credential-audit-model-secret';
  settings.llm.claudeKey = 'credential-audit-claude-secret';
  settings.llm.model = 'fixture-model';
  settings.asr.fileApiKey = 'credential-audit-file-secret';
  settings.asr.fileUrl = 'http://127.0.0.1:9001/transcriptions?token=credential-audit-url-secret';
  settings.asr.headers = { Authorization: 'Bearer credential-audit-header-secret' };
  settings.asr.init = { nested: { accessToken: 'credential-audit-init-secret' } };
  settings.asr.audioEnvelope = { password: 'credential-audit-envelope-secret' };
  settings.mcp = [
    {
      name: 'audit',
      transport: 'stdio',
      command: 'node',
      enabled: false,
      args: ['--token=credential-audit-args-secret'],
      env: { SECRET: 'credential-audit-env-secret' },
    },
  ];
  const legacy = new Store(filename);
  legacy.saveSettings(settings);
  legacy.close();
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.STUDIO_PACKAGED;

  const launch = () =>
    _electron.launch({
      ...(packaged ? { executablePath: packaged } : {}),
      args: packaged ? [] : ['.'],
      env,
      timeout: 60000,
    });

  let app;
  try {
    app = await launch();
    const page = await require('../setup/helpers.cjs').firstWindow(app);
    await page.waitForLoadState('load');
    await page.waitForFunction(() => !!window.studio);
    const publicSettings = await page.evaluate(
      async () => (await window.studio.invoke('bootstrap')).settings
    );
    assert.equal(publicSettings.llm.apiKey, '••••••••');
    assert.equal(publicSettings.llm.claudeKey, '••••••••');
    assert.equal(publicSettings.asr.fileApiKey, '••••••••');
    assert.deepEqual(publicSettings.asr.init, settings.asr.init);
    const db = new DatabaseSync(filename);
    const stored = db.prepare('SELECT data FROM settings').get().data;
    db.close();
    assert.match(stored, /^protected-settings:v2:/);
    assert.equal(stored.includes('credential-audit-'), false);
    const matches = await app.evaluate(async ({ safeStorage }, ciphertext) => {
      const decoded = JSON.parse(
        (
          await safeStorage.decryptStringAsync(
            Buffer.from(ciphertext.slice('protected-settings:v2:'.length), 'base64')
          )
        ).result
      );
      return (
        decoded.llm.apiKey === 'credential-audit-model-secret' &&
        decoded.mcp[0].env.SECRET === 'credential-audit-env-secret' &&
        decoded.asr.audioEnvelope.password === 'credential-audit-envelope-secret'
      );
    }, stored);
    assert.equal(matches, true);
    await page.evaluate(async () => {
      const current = (await window.studio.invoke('bootstrap')).settings;
      current.theme = 'dark';
      await window.studio.invoke('settings:save', current);
    });
    await page.reload();
    await page.waitForFunction(() => !!window.studio);
    assert.equal(
      await page.evaluate(async () => (await window.studio.invoke('bootstrap')).settings.theme),
      'dark'
    );
    await app.close();
    app = null;
    app = await launch();
    const restored = await require('../setup/helpers.cjs').firstWindow(app);
    await restored.waitForLoadState('load');
    const saved = await restored.evaluate(
      async () => (await window.studio.invoke('bootstrap')).settings
    );
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.llm.apiKey, '••••••••');
    assert.deepEqual(saved.asr.audioEnvelope, settings.asr.audioEnvelope);
    await app.close();
    app = null;
    for (const name of await fs.readdir(profile)) {
      if (!name.startsWith('studio.sqlite')) continue;
      assert.equal(
        (await fs.readFile(path.join(profile, name))).includes(Buffer.from('credential-audit-')),
        false
      );
    }
    console.log(
      'Credential UI passed: real OS encryption, automatic legacy migration, ciphertext at rest, masked API keys, custom secrets, reload and application restart/save roundtrip.'
    );
  } finally {
    await app?.close();
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('studio-credential-ui-'));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
