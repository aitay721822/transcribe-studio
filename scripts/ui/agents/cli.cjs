const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cli-ui-'));
  const fixture = path.resolve('tests/fixtures/agent-cli.cjs');
  const env = {
    ...process.env,
    STUDIO_TEST_DATA: profile,
    STUDIO_CODEX_PATH: fixture,
    STUDIO_CLAUDE_PATH: fixture,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    ...(process.env.STUDIO_PACKAGED ? { executablePath: process.env.STUDIO_PACKAGED } : {}),
    args: process.env.STUDIO_PACKAGED ? [] : ['.'],
    env,
  });
  try {
    const page = await require('../setup/helpers.cjs').desktopWindow(app),
      errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.setup-page').waitFor();
    await page.locator('#setup-asr-file-url').fill('http://127.0.0.1:9001/v1/audio/transcriptions');
    await page.locator('#setup-next').click();
    await page.locator('#setup-backend').selectOption('codex');
    assert.equal(await page.locator('#setup-codex-auth').inputValue(), 'cli');
    assert.equal(await page.locator('#setup-llm-key').count(), 0);
    assert.equal(await page.locator('#setup-codex-cli-model').inputValue(), '');
    await page.getByText('CLI 已登入').first().waitFor();
    assert.equal(
      await page.locator('#setup-agent-models option[value="fixture-model"]').count(),
      1
    );
    await page.locator('#setup-test').click();
    await page.locator('#agent-connection-start').click();
    await page.locator('#agent-connection-reply').filter({ hasText: 'fixture Codex' }).waitFor();
    await page.locator('#modal [data-close-modal]').click();
    await page.locator('#setup-backend').selectOption('claude');
    assert.equal(await page.locator('#setup-claude-auth').inputValue(), 'cli');
    assert.equal(await page.locator('#setup-claude-key').count(), 0);
    await page.locator('#setup-claude-auth').selectOption('api');
    await page.locator('#setup-claude-key').fill('saved-fixture-key');
    await page.locator('#setup-claude-model').fill('fixture-claude-model');
    await page.locator('#setup-claude-auth').selectOption('cli');
    assert.equal(await page.locator('#setup-claude-key').count(), 0);
    await page.locator('#setup-claude-model').fill('');
    await page.locator('#setup-test').click();
    await page.locator('#agent-connection-start').click();
    await page.locator('#agent-connection-reply').filter({ hasText: 'fixture Claude' }).waitFor();
    await page.locator('#modal [data-close-modal]').click();
    await fs.mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/setup-cli-login.png' });
    await page.locator('#setup-next').click();
    await page.getByRole('heading', { name: '工作區已準備好' }).waitFor();
    await page.locator('#setup-next').click();
    await page.locator('.hero').waitFor();
    await page.reload();
    await page.locator('.hero').waitFor();
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    await page.locator('#claude-auth').waitFor();
    assert.equal(await page.locator('#claude-auth').inputValue(), 'cli');
    assert.equal(await page.locator('#claude-key').count(), 0);
    await page.locator('#claude-auth').selectOption('api');
    assert.equal(await page.locator('#claude-key').inputValue(), '••••••••');
    await page.locator('#claude-auth').selectOption('cli');
    await page.locator('[data-action="save-settings"]').click();
    const saved = await page.evaluate(
      async () => (await window.studio.invoke('bootstrap')).settings.llm
    );
    assert.equal(saved.claudeAuth, 'cli');
    assert.equal(saved.claudeKey, '••••••••');
    await app.evaluate(() => {
      process.env.STUDIO_FIXTURE_ACCOUNT = 'signed-out';
    });
    await page.getByRole('button', { name: '重新偵測 CLI' }).click();
    await page.getByText('尚未登入，請執行 claude auth login', { exact: true }).waitFor();
    await page.locator('[data-action="test-agent-connection"]').click();
    await page.locator('#agent-connection-start').click();
    await page
      .locator('#agent-connection-error')
      .filter({ hasText: 'claude auth login' })
      .waitFor();
    await page.locator('#modal [data-close-modal]').click();
    await app.evaluate(() => {
      delete process.env.STUDIO_FIXTURE_ACCOUNT;
    });
    await page.locator('#llm-backend').selectOption('codex');
    assert.equal(await page.locator('#llm-key').count(), 0);
    await page.locator('#codex-auth').selectOption('api');
    await page.locator('#llm-key').fill('saved-codex-key');
    await page.locator('#llm-model').fill('api-model');
    await page.locator('#codex-auth').selectOption('cli');
    assert.equal(await page.locator('#codex-cli-model').inputValue(), '');
    await page.locator('[data-action="save-settings"]').click();
    await page.evaluate(async () => {
      const s = (await window.studio.invoke('bootstrap')).settings;
      s.theme = 'dark';
      await window.studio.invoke('settings:save', s);
    });
    await page.reload();
    await page.locator('.hero').waitFor();
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="agent"]').click();
    await page.locator('#codex-auth').waitFor();
    await page.getByRole('button', { name: '重新偵測 CLI' }).waitFor({ state: 'visible' });
    await page.waitForFunction(
      () =>
        !document
          .getAnimations()
          .some(
            (animation) =>
              animation.playState === 'running' &&
              animation.effect?.getComputedTiming().iterations !== Infinity
          )
    );
    await page.screenshot({ path: 'output/playwright/settings-cli-login-dark.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 760));
    await page.waitForFunction(() => innerWidth === 700);
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector('.settings-scroll').scrollWidth >
          document.querySelector('.settings-scroll').clientWidth
      ),
      false
    );
    await page.screenshot({ path: 'output/playwright/settings-cli-login-700.png' });
    assert.deepEqual(errors, []);
    console.log(
      'CLI UI passed: no-key onboarding, both CLI connection tests, model catalog, auth mode/key preservation, signed-out recovery, persistence and RWD.'
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
