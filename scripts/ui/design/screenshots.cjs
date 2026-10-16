const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store, DEFAULTS } = require('../../../dist/persistence/store.cjs');
const { firstWindow, resizeWindow } = require('../setup/helpers.cjs');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-readme-'));
  const destination = path.resolve('docs/images');
  await fs.mkdir(destination, { recursive: true });
  const store = new Store(path.join(profile, 'studio.sqlite'));
  const settings = structuredClone(DEFAULTS);
  settings.theme = 'light';
  settings.asr.fileUrl = 'http://127.0.0.1:1/transcriptions';
  settings.asr.fileModel = 'demo-transcription';
  settings.llm.baseUrl = 'http://127.0.0.1:1/v1';
  settings.llm.apiKey = 'demo-only';
  settings.llm.model = 'demo-assistant';
  store.saveSettings(settings);
  const project = store.createProject('產品開發');
  const meeting = store.createMeeting(project.id, '產品週會・需求與下一步');
  const notes =
    '# 產品週會\n\n## 本週決議\n- 首頁優先呈現專案與最近會議。\n- 即時辨識改為在停頓處分段。\n- 會議紀錄保留來源，方便會後核對。\n\n## 待辦事項\n| 事項 | 負責人 | 時程 |\n| --- | --- | --- |\n| 確認首頁資訊層級 | 設計團隊 | 下週一 |\n| 測試不同收音裝置 | 工程團隊 | 下週三 |\n| 彙整使用者回饋 | 產品團隊 | 下次週會 |\n\n## 下次討論\n檢查辨識品質與操作回饋，確認下一階段優先順序。';
  store.putMeeting({
    ...store.updateMeeting(meeting.id, {
      status: 'completed',
      duration: 1380,
      notes,
    }),
    segments: [
      {
        id: 'demo-1',
        start: 12,
        end: 26,
        text: '今天先確認首頁的資訊層級，希望一進來就能找到專案與最近的會議。',
        final: true,
      },
      {
        id: 'demo-2',
        start: 35,
        end: 51,
        text: '語音辨識會優先等到停頓再分段，減少在句子中間切開的情況。',
        final: true,
      },
      {
        id: 'demo-3',
        start: 65,
        end: 82,
        text: '整理後的決議要保留逐字稿來源，方便大家回頭確認。',
        final: true,
      },
      {
        id: 'demo-4',
        start: 98,
        end: 116,
        text: '下週由設計團隊確認首頁，工程團隊測試收音裝置，產品團隊彙整回饋。',
        final: true,
      },
      {
        id: 'demo-5',
        start: 130,
        end: 146,
        text: '首頁的確認時間先訂在下週一，收音裝置的測試結果下週三一起整理。',
        final: true,
      },
      {
        id: 'demo-6',
        start: 158,
        end: 176,
        text: '訪談回饋會放回專案，下一次討論可以直接參考，不用重新尋找文件。',
        final: true,
      },
      {
        id: 'demo-7',
        start: 190,
        end: 208,
        text: '還不確定的地方先列為待確認問題，等實際測試完成再一起做決定。',
        final: true,
      },
    ],
  });
  const second = store.createMeeting(project.id, '使用者訪談・操作體驗', 'file');
  store.updateMeeting(second.id, {
    status: 'completed',
    notes: '# 訪談紀錄\n\n彙整搜尋與錄音操作的回饋。',
    duration: 2160,
  });
  store.createMeeting(project.id, '下階段規劃');
  store.close();
  const env = { ...process.env, STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env });
  try {
    const page = await firstWindow(app);
    await resizeWindow(app, page, 1680, 1000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.hero').waitFor();
    await page.locator(`[data-project="${project.id}"]`).click();
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor();
    await page.screenshot({ path: path.join(destination, 'project-overview.png') });
    await page.locator(`.meeting-row[data-meeting="${meeting.id}"]`).click();
    await page.locator('#notes-editor').waitFor();
    await page.locator('[data-editor-tab="preview"]').click();
    await page.locator('.document-preview').waitFor();
    assert.equal(await page.locator('#source-body .segment').count(), 7);
    await page.locator('#source-body .segment').first().scrollIntoViewIfNeeded();
    await page.locator('#source-body').evaluate((body) => {
      const first = body.querySelector('.segment');
      body.scrollTop += first.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
    });
    await page
      .locator('#agent-input')
      .fill('請根據逐字稿核對本週決議，補上待辦事項與尚待確認的問題。');
    const activeTabs = await page.locator('.tabs .tab.active').evaluateAll((tabs) =>
      tabs.map((tab) => {
        const style = getComputedStyle(tab);
        return {
          rounded: parseFloat(style.borderRadius) >= 8,
          balanced: style.borderTopWidth === style.borderBottomWidth,
          filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
        };
      })
    );
    assert(activeTabs.length >= 2);
    assert(activeTabs.every((tab) => tab.rounded && tab.balanced && tab.filled));
    await page.screenshot({ path: path.join(destination, 'meeting-workspace.png') });
    await fs.mkdir('output/playwright', { recursive: true });
    await page
      .locator('.tabs')
      .first()
      .screenshot({ path: 'output/playwright/workspace-rounded-tabs.png' });
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-settings-tab="appearance"]').click();
    await page.locator('.theme-options').waitFor();
    assert.equal(await page.locator('[data-theme-option]').count(), 9);
    await page.screenshot({ path: path.join(destination, 'appearance.png') });
    console.log(
      'README screenshots saved with isolated demo data; rounded workspace tabs verified.'
    );
  } finally {
    await app.close();
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert(path.basename(profile).startsWith('studio-readme-'));
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
