import type { BrowserWindow } from 'electron';
import { nativeTheme, safeStorage } from 'electron';
import { agentAuth } from '../domain/agents/auth';
import { compressionSettings } from '../domain/agents/compression';
import { executionLimits } from '../domain/agents/limits';
import type { Meeting, Settings } from '../domain/models';
import { transcriptionEndpoint } from '../domain/transcription';
import type { Store } from '../persistence/store';
import { DEFAULTS } from '../persistence/store';
import { detectAgents } from '../services/agents/detection';
import type { DesktopContext } from './context';

export function createSettings(store: Store, getWindow: () => BrowserWindow) {
  const winProxy = () => getWindow();

  const MASK = '••••••••';

  function encrypt(value: string) {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('作業系統憑證加密不可用，無法儲存秘密');
    return `encrypted:${safeStorage.encryptString(value).toString('base64')}`;
  }

  function decrypt(value: string) {
    if (!value?.startsWith('encrypted:')) return value || '';
    return safeStorage.decryptString(Buffer.from(value.slice(10), 'base64'));
  }

  function settingsInternal() {
    const s = store.settings();
    s.asr = { ...DEFAULTS.asr, ...s.asr, fileApiKey: s.asr.fileApiKey ?? s.asr.apiKey };
    s.llm.apiKey = decrypt(s.llm.apiKey);
    s.asr.apiKey = decrypt(s.asr.apiKey);
    s.asr.fileApiKey = decrypt(s.asr.fileApiKey);
    s.llm = { ...DEFAULTS.llm, ...s.llm, claudeKey: decrypt(s.llm.claudeKey || '') };
    if (s.llm.backend === 'responses') s.llm.backend = 'openai';
    s.llm.codexAuth = agentAuth(s.llm, 'codex');
    s.llm.claudeAuth = agentAuth(s.llm, 'claude');
    if (typeof s.asr.headers === 'string') s.asr.headers = JSON.parse(decrypt(s.asr.headers));
    if (typeof s.asr.fileHeaders === 'string')
      s.asr.fileHeaders = JSON.parse(decrypt(s.asr.fileHeaders));
    s.asr.fileHeaders ||= {};
    if (typeof s.asr.iceServers === 'string')
      s.asr.iceServers = JSON.parse(decrypt(s.asr.iceServers));
    s.asr.iceServers ||= [];
    if (typeof s.mcp === 'string') s.mcp = JSON.parse(decrypt(s.mcp));
    return s;
  }

  function settingsPublic() {
    const s = settingsInternal();
    s.llm.apiKey = s.llm.apiKey ? MASK : '';
    s.llm.claudeKey = s.llm.claudeKey ? MASK : '';
    s.asr.apiKey = s.asr.apiKey ? MASK : '';
    s.asr.fileApiKey = s.asr.fileApiKey ? MASK : '';
    return s;
  }

  function applyWindowTheme(theme: string) {
    const windowTheme = () => {
      if (theme === 'forest' || theme === 'dark') {
        return 'dark';
      }
      if (theme === 'light') {
        return 'light';
      }
      return 'system';
    };

    nativeTheme.themeSource = windowTheme();
    const win = winProxy();
    if (win && process.platform === 'win32') win.setBackgroundMaterial('acrylic');
  }

  function sanitizeMeeting(m: Meeting): Meeting {
    return {
      ...m,
      agentSessions: undefined,
      recordings: m.recordings.map((r): import('../domain/models').Recording => ({
        ...r,
        path: undefined,
        url: `studio-media://audio/${r.id}`,
      })),
    };
  }

  function saveSettings(s: Partial<Settings>) {
    const prev = settingsInternal();
    const next = {
      theme: ['light', 'dark', 'system', 'forest'].includes(s.theme) ? s.theme : 'system',
      llm: { ...DEFAULTS.llm, ...s.llm },
      asr: { ...DEFAULTS.asr, ...s.asr, mapping: { ...DEFAULTS.asr.mapping, ...s.asr?.mapping } },
      mcp: s.mcp || [],
    };
    for (const k of ['llm', 'asr'] as const) {
      if (next[k].apiKey === MASK) next[k].apiKey = prev[k].apiKey;
      next[k].apiKey = encrypt(next[k].apiKey);
    }
    if (next.asr.fileApiKey === MASK) next.asr.fileApiKey = prev.asr.fileApiKey;
    const fileApiKey = next.asr.fileApiKey;
    if (next.llm.claudeKey === MASK) next.llm.claudeKey = prev.llm.claudeKey;
    next.llm.claudeKey = encrypt(next.llm.claudeKey);
    if (!['openai', 'codex', 'claude', 'responses'].includes(next.llm.backend))
      throw new Error('無效的 harness');
    for (const field of ['codexAuth', 'claudeAuth'] as const)
      if (next.llm[field] && !['cli', 'api'].includes(next.llm[field]))
        throw new Error('無效的認證方式');
    Object.assign(next.llm, executionLimits(next.llm));
    Object.assign(next.llm, compressionSettings(next.llm));
    if (next.llm.backend !== 'claude' && agentAuth(next.llm) === 'api') {
      const base = new URL(next.llm.baseUrl);
      if (!['https:', 'http:'].includes(base.protocol)) throw new Error('模型端點必須使用 HTTP(S)');
    }
    if (!['openai', 'transcriptions', 'websocket', 'webrtc'].includes(next.asr.provider))
      throw new Error('無效的 ASR 類型');
    if (next.asr.fileUrl?.trim()) transcriptionEndpoint(next.asr);
    if (![16000, 24000, 48000].includes(Number(next.asr.sampleRate)))
      throw new Error('取樣率必須為 16000、24000 或 48000');
    if (!Array.isArray(next.mcp) || next.mcp.length > 12)
      throw new Error('MCP 設定必須為陣列，最多 12 個伺服器');
    for (const server of next.mcp) {
      if (!server.name || !['stdio', 'http'].includes(server.transport))
        throw new Error('MCP 需要 name 與 transport (stdio/http)');
      if (server.transport === 'stdio' && (!server.command || !Array.isArray(server.args || [])))
        throw new Error('MCP stdio 需要 command 與 args 陣列');
      if (server.transport === 'http' && !/^https?:\/\//.test(server.url))
        throw new Error('MCP HTTP URL 無效');
      if (server.headers && (Array.isArray(server.headers) || typeof server.headers !== 'object'))
        throw new Error('MCP headers 需要 JSON 物件');
      if (
        server.env &&
        (Array.isArray(server.env) ||
          typeof server.env !== 'object' ||
          Object.values(server.env).some((v) => typeof v !== 'string'))
      )
        throw new Error('MCP env 的值必須為字串');
    }
    if (!Array.isArray(next.asr.iceServers)) throw new Error('WebRTC ICE servers 需要 JSON 陣列');
    store.saveSettings({
      ...next,
      asr: {
        ...next.asr,
        headers: encrypt(JSON.stringify(next.asr.headers || {})),
        fileHeaders: encrypt(JSON.stringify(next.asr.fileHeaders || {})),
        fileApiKey: encrypt(fileApiKey),
        iceServers: encrypt(JSON.stringify(next.asr.iceServers)),
      },
      mcp: encrypt(JSON.stringify(next.mcp)),
    });
    applyWindowTheme(next.theme);
    return settingsPublic();
  }

  return { settingsInternal, settingsPublic, saveSettings, applyWindowTheme, sanitizeMeeting };
}

export function registerSettings(ctx: DesktopContext) {
  ctx.handle('settings:save', ctx.saveSettings);
  let detecting: ReturnType<typeof detectAgents> | null = null;
  ctx.handle('agents:detect', (draft) => {
    if (draft) return detectAgents({ ...ctx.settingsInternal().llm, ...draft });
    detecting ||= detectAgents(ctx.settingsInternal().llm).finally(() => {
      detecting = null;
    });
    return detecting;
  });
}
