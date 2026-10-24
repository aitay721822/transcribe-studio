import { compressionSettings } from '../../domain/agents/compression';
import { executionLimits } from '../../domain/agents/limits';
import type { LlmSettings } from '../../domain/models';
import { checkboxChecked } from '../primitives/checkbox';
import { $, type UiRuntime } from './runtime';

export function createSettingsController(host: UiRuntime) {
  const { state, api, applyTheme, toast } = host;

  function collectSettings() {
    const s = structuredClone(state.settings);

    const value = (id: string) => $(`#${id}`)?.value;

    const json = (id: string) => {
      try {
        const parsed = JSON.parse(value(id));
        if (!parsed || typeof parsed !== 'object') throw new Error();
        return parsed;
      } catch {
        throw new Error(`${id} 需要有效的 JSON`);
      }
    };

    if (state.settingsTab === 'asr')
      s.asr = {
        ...s.asr,
        provider: checkboxChecked('asr-realtime-enabled') ? 'openai' : 'transcriptions',
        apiKey: value('asr-key'),
        model: value('asr-model'),
        fileModel: value('asr-file-model'),
        fileUrl: value('asr-file-url').trim(),
        fileApiKey: value('asr-file-key'),
        fileHeaders: json('asr-file-headers'),
        chunkSeconds: Number(value('asr-chunk-seconds')),
        realtimeFlavor: value('asr-flavor'),
        disablePerMessageDeflate: checkboxChecked('asr-disable-per-message-deflate'),
        language: value('asr-language'),
        url: value('asr-url'),
        headers: json('asr-headers'),
      };
    if (state.settingsTab === 'agent') {
      const number = (id: string) => (value(id)?.trim() ? Number(value(id)) : Number.NaN);

      s.llm = {
        ...s.llm,
        backend: value('llm-backend') as LlmSettings['backend'],
        baseUrl: value('llm-url')?.trim() ?? s.llm.baseUrl,
        apiKey: value('llm-key') ?? s.llm.apiKey,
        model: value('llm-model')?.trim() ?? s.llm.model,
        codexAuth: (value('codex-auth') as LlmSettings['codexAuth']) ?? s.llm.codexAuth,
        claudeAuth: (value('claude-auth') as LlmSettings['claudeAuth']) ?? s.llm.claudeAuth,
        codexModel: value('codex-cli-model')?.trim() ?? s.llm.codexModel,
        codexPath: value('codex-path')?.trim() ?? s.llm.codexPath,
        claudeKey: value('claude-key') ?? s.llm.claudeKey,
        claudeModel: value('claude-model')?.trim() ?? s.llm.claudeModel,
        claudePath: value('claude-path')?.trim() ?? s.llm.claudePath,
        ...compressionSettings({
          autoCompact: checkboxChecked('llm-auto-compact'),
          compactThreshold: number('llm-compact-threshold'),
        }),
        ...executionLimits({
          maxSteps: number('llm-steps'),
          maxToolCalls: number('llm-tools'),
          timeoutMinutes: number('llm-timeout'),
        }),
      };
    }
    if (state.settingsTab === 'mcp') s.mcp = json('mcp-config');
    return s;
  }

  async function saveSettings() {
    state.settings = await api('settings:save', collectSettings());
    applyTheme(state.settings.theme);
    toast('設定已儲存');
    if (!(await host.refreshSetupGate())) host.startSetup();
  }

  async function toggleTheme() {
    state.settings = await api('settings:save', {
      ...state.settings,
      theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light',
    });
    applyTheme(state.settings.theme);
    if (!(await host.refreshSetupGate())) host.startSetup();
  }

  return { collectSettings, saveSettings, toggleTheme };
}

export type SettingsController = ReturnType<typeof createSettingsController>;
