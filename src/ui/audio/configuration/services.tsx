import { useState } from 'react';
import type { AsrSettings } from '../../../domain/asr/config';
import { TRANSCRIPTION_URL } from '../../../domain/transcription';
import { closeDropdown } from '../../components/dropdown';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { Select } from '../../primitives/select';
import { Textarea } from '../../primitives/textarea';

export function SpeechServices({
  config: c,
  prefix = '',
  wizard = false,
}: {
  config: AsrSettings;
  prefix?: string;
  wizard?: boolean;
}) {
  const [tab, setTab] = useState('offline');
  const [enabled, setEnabled] = useState(['openai', 'websocket', 'webrtc'].includes(c.provider));

  const id = (name: string) => `${prefix}asr-${name}`;

  const switchTab = (value: string) => {
    closeDropdown();
    setTab(value);
  };

  const tabs = [
    ['offline', '離線辨識（必填）'],
    ['realtime', '即時辨識（選用）'],
  ];

  const field = (label: string, name: string, value: string, type = 'text', hint = '') => (
    <div className="field full">
      <label htmlFor={id(name)}>{label}</label>
      {type === 'textarea' ? (
        <Textarea id={id(name)} rows={3} spellCheck={false} defaultValue={value} />
      ) : (
        <Input id={id(name)} type={type} defaultValue={value} autoComplete="off" />
      )}
      {hint && <small>{hint}</small>}
    </div>
  );

  const select = (label: string, name: string, selected: string, options: string[][]) => (
    <div className="field full">
      <label htmlFor={id(name)}>{label}</label>
      <Select id={id(name)}>
        {options.map(([value, text]) => (
          <option key={value} value={value} data-selected={value === selected}>
            {text}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <>
      <section className={wizard ? '' : 'panel settings-section'}>
        <h2>辨識服務</h2>
        <p className="help">先完成離線辨識設定，即時辨識可依需要啟用。</p>
        <div className="service-tabs" role="tablist" aria-label="辨識服務類別">
          {tabs.map(([value, label], index) => (
            <Button
              key={value}
              variant="ghost"
              role="tab"
              id={id(`${value}-tab`)}
              aria-selected={tab === value}
              aria-controls={id(`${value}-panel`)}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => switchTab(value)}
              onKeyDown={(event) => {
                const navigationDirection = () => {
                  if (event.key === 'ArrowRight') {
                    return 1;
                  }
                  if (event.key === 'ArrowLeft') {
                    return -1;
                  }
                  return 0;
                };

                const direction = navigationDirection();
                if (!direction && !['Home', 'End'].includes(event.key)) return;
                event.preventDefault();

                const destinationTab = () => {
                  if (event.key === 'Home') {
                    return 0;
                  }
                  if (event.key === 'End') {
                    return 1;
                  }
                  return (index + direction + 2) % 2;
                };

                const target = destinationTab();
                switchTab(tabs[target][0]);
                document.getElementById(id(`${tabs[target][0]}-tab`))?.focus();
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      </section>
      <section
        className={wizard ? 'setup-service' : 'panel settings-section'}
        aria-label="離線辨識設定"
        role="tabpanel"
        id={id('offline-panel')}
        aria-labelledby={id('offline-tab')}
        hidden={tab !== 'offline'}
      >
        <h2>離線辨識</h2>
        <p className="help">
          透過 /audio/transcriptions 上傳音檔。用於收音時，會累積一段音訊再上傳，逐段回傳文字。
        </p>
        <div className="form-grid">
          {field(
            'HTTP 轉錄端點',
            'file-url',
            c.fileUrl ?? TRANSCRIPTION_URL,
            'url',
            '填完整 URL，例如 http://localhost:8000/v1/audio/transcriptions；不會自動追加路徑。'
          )}
          {field(
            '離線辨識 API key（選填）',
            'file-key',
            c.fileApiKey ?? c.apiKey ?? '',
            'password',
            '官方 OpenAI 必填；無驗證的本機服務可留白。'
          )}
          {field('音檔辨識模型', 'file-model', c.fileModel || '')}
          {field('語言代碼', 'language', c.language || '', 'text', '例如 zh、en；留白由模型判斷。')}
          {select('HTTP 收音分段秒數', 'chunk-seconds', String(c.chunkSeconds || 5), [
            ['2', '2 秒'],
            ['5', '5 秒'],
            ['10', '10 秒'],
            ['15', '15 秒'],
          ])}
          {field(
            '離線驗證 Headers（JSON）',
            'file-headers',
            JSON.stringify(c.fileHeaders || {}, null, 2),
            'textarea',
            '可設定 Authorization 或自訂驗證標頭。Content-Type 由上傳程式自動產生。'
          )}
        </div>
        <Button
          variant="outline"
          id={wizard ? 'setup-test-offline' : undefined}
          className="max-w-full whitespace-normal"
          data-action={wizard ? undefined : 'test-offline-connection'}
        >
          測試離線辨識（裝置說話）
        </Button>
      </section>
      <section
        className={wizard ? 'setup-service' : 'panel settings-section'}
        aria-label="即時辨識設定"
        role="tabpanel"
        id={id('realtime-panel')}
        aria-labelledby={id('realtime-tab')}
        hidden={tab !== 'realtime'}
      >
        <h2>即時辨識</h2>
        <label className="check-line">
          <input
            id={id('realtime-enabled')}
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          啟用即時辨識
        </label>
        <p className="help">未啟用時，會議收音使用離線服務的分段辨識；即時設定可保留供日後使用。</p>
        <p className="help">
          透過 /v1/realtime WebSocket 傳送 PCM 音訊。選擇與服務相符的 Realtime 協定。
        </p>
        <div className="form-grid">
          {select('Realtime 協定', 'flavor', c.realtimeFlavor || 'openai', [
            ['openai', 'OpenAI / OpenAI 相容服務'],
            ['vllm', 'vLLM'],
          ])}
          {field(
            'Realtime WebSocket 端點',
            'url',
            c.url || '',
            'url',
            '例如 wss://api.openai.com/v1/realtime 或 ws://localhost:8000/v1/realtime。'
          )}
          {field(
            '即時辨識 API key（選填）',
            'key',
            c.apiKey || '',
            'password',
            '官方 OpenAI 必填；自架服務依其驗證要求填寫。'
          )}
          {field('即時辨識模型', 'model', c.model || '')}
          {field(
            '即時驗證 Headers（JSON）',
            'headers',
            JSON.stringify(c.headers || {}, null, 2),
            'textarea'
          )}
        </div>
        <p className="help">OpenAI 使用 24 kHz PCM16；vLLM 使用 16 kHz PCM16。音訊會自動轉換。</p>
        <Button
          variant="outline"
          id={wizard ? 'setup-test-realtime' : undefined}
          className="max-w-full whitespace-normal"
          data-action={wizard ? undefined : 'test-realtime-connection'}
        >
          測試即時辨識（裝置說話）
        </Button>
      </section>
    </>
  );
}
