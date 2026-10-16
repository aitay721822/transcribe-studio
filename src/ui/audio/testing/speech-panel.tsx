import { useEffect, useRef, useState } from 'react';
import { selectedSource } from '../../../domain/audio-devices';
import type { Settings, TranscriptSegment } from '../../../domain/models';
import { Button } from '../../primitives/button';
import { useInputDevices } from '../devices/discovery';
import { DeviceDetails, DevicePicker } from '../devices/picker';
import { SpeechConnectionTest } from './speech';

export function SpeechTestPanel({
  settings,
  initialDevice = 'mic:',
  initialMicrophone = '',
  initialPlayback = '',
}: {
  settings: Settings;
  initialDevice?: string;
  initialMicrophone?: string;
  initialPlayback?: string;
}) {
  const [device, setDevice] = useState(initialDevice);
  const [playback, setPlayback] = useState(
    ['system', 'both'].includes(initialDevice) ? initialPlayback : 'none'
  );
  const source = device.startsWith('mic:') ? 'mic' : device;
  const [status, setStatus] = useState('選擇裝置，開始後說一段話，例如「今天要確認會議決議」。');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [connecting, setConnecting] = useState(false);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [connected, setConnected] = useState(false),
    [captured, setCaptured] = useState(false),
    [ending, setEnding] = useState(false);
  const session = useRef<SpeechConnectionTest>(null),
    alive = useRef(true),
    meter = useRef<HTMLDivElement>(null);
  const token = useRef(0);
  const [microphone, setMicrophone] = useState(
    initialDevice.startsWith('mic:') ? initialDevice.slice(4) : initialMicrophone
  );
  const microphoneValue = ['system', 'none'].includes(source) ? 'none' : `mic:${microphone}`;
  const { devices, loading, error: deviceError, refresh } = useInputDevices(busy);
  const [actual, setActual] = useState<{
    label: string;
    sampleRate?: number;
    channelCount?: number;
  }>();
  useEffect(() => {
    if (
      !loading &&
      !deviceError &&
      !busy &&
      (source === 'both' || source === 'mic') &&
      !devices.some((d) => d.id === microphone)
    ) {
      if (source === 'mic') setDevice('mic:');
      setMicrophone('');
      setActual(undefined);
    }
  }, [devices, loading, busy, deviceError, source, microphone]);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.studio.on('connection:event', (event) => {
      if (event.id !== session.current?.id) return;
      if (event.type === 'status') setStatus(event.message);
      if (event.type === 'segment') {
        setConnected(true);
        setSegments((all) => {
          const previous = all.find((s) => s.id === event.segment.id);
          if (previous?.final && !event.segment.final) return all;
          return [...all.filter((s) => s.id !== event.segment.id), event.segment]
            .sort((a, b) => a.start - b.start)
            .slice(-100);
        });
      }
      if (['error', 'closed', 'timeout'].includes(event.type)) {
        setError(event.type === 'closed' ? '辨識服務意外中斷，請重新測試' : event.message);
        setBusy(false);
        setConnecting(false);
        void session.current?.stop(false);
      }
    });
    return () => {
      alive.current = false;
      token.current++;
      unsubscribe();
      void session.current?.stop(false);
    };
  }, []);

  async function start() {
    if (busy || loading) return;
    const revision = ++token.current;
    setBusy(true);
    setConnecting(true);
    setError('');
    setSegments([]);
    setConnected(false);
    setCaptured(false);
    setStatus('正在開啟所選音訊裝置…');
    let previous = 0;
    const test = new SpeechConnectionTest(window.studio.invoke, (event) => {
      if (!alive.current || token.current !== revision) return;
      if (event.type === 'level') {
        if (performance.now() - previous < 50) return;
        previous = performance.now();
        if (meter.current)
          meter.current.style.transform = `scaleX(${Math.min(1, event.level * 6)})`;
        if (event.level > 0.012) setCaptured(true);
      } else if (event.type === 'device') {
        setActual({
          label: event.label || '',
          sampleRate: event.sampleRate,
          channelCount: event.channelCount,
        });
      } else if (event.type === 'ready') {
        setConnecting(false);
        setConnected(event.connected !== false);
        setStatus(event.message);
      } else if (event.type === 'status') setStatus(event.message);
      else if (event.type === 'error') {
        setError(event.message);
        setBusy(false);
        setConnecting(false);
      }
    });
    session.current = test;
    try {
      await test.start(settings, source, microphone, playback === 'none' ? '' : playback);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current && token.current === revision) {
        setError(e.message);
        setBusy(false);
        setConnecting(false);
      }
    }
  }

  async function stop() {
    if (ending) return;
    const graceful = !connecting;
    token.current++;
    setEnding(true);
    setConnecting(true);
    setStatus('正在結束串流，等待最後辨識文字…');
    try {
      await session.current?.stop(graceful);
      if (alive.current) setStatus('測試已結束。可核對下方辨識文字，或重新測試。');
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setConnecting(false);
        setEnding(false);
        if (meter.current) meter.current.style.transform = 'scaleX(0)';
      }
    }
  }

  const stopLabel = () => {
    if (ending) {
      return '等待最後辨識…';
    }
    if (connecting) {
      return '取消連線';
    }
    return '結束並取得辨識';
  };

  return (
    <div className="connection-test">
      <p className="help">音訊會傳送至目前選定的辨識服務，最長 90 秒；測試不建立會議或儲存錄音。</p>
      <DevicePicker
        id="connection-device"
        devices={devices}
        value={microphoneValue}
        playback={playback}
        disabled={busy || loading}
        onChange={(e) => {
          setDevice(selectedSource(playback, e.target.value));
          setActual(undefined);
          if (e.target.value.startsWith('mic:')) setMicrophone(e.target.value.slice(4));
        }}
        onPlaybackChange={(event) => {
          setPlayback(event.target.value);
          setDevice(selectedSource(event.target.value, microphoneValue));
          setActual(undefined);
        }}
      />
      <DeviceDetails
        devices={devices}
        value={source === 'mic' ? `mic:${microphone}` : source}
        actual={actual}
        microphoneId={microphone}
      />
      {deviceError && (
        <p className="error" role="alert">
          {deviceError}
        </p>
      )}
      <div className="button-row connection-actions">
        <Button
          className="btn"
          variant="outline"
          onClick={() => refresh()}
          disabled={busy || loading}
        >
          {loading ? '正在取得名稱…' : '偵測完整裝置名稱'}
        </Button>
        {busy ? (
          <Button
            className="btn"
            id="connection-stop"
            variant="outline"
            onClick={stop}
            disabled={ending}
          >
            {stopLabel()}
          </Button>
        ) : (
          <Button
            className="btn primary"
            id="connection-start"
            onClick={start}
            disabled={loading || source === 'none'}
          >
            開始說話辨識測試
          </Button>
        )}
      </div>
      <div className="connection-level" aria-label="即時音量">
        <div ref={meter} />
      </div>
      <p id="connection-status" role="status">
        {status}
      </p>
      <p className="help">
        連線：{connected ? '已確認' : '未確認'} · 收音：{captured ? '已擷取聲音' : '等待說話'} ·
        辨識：{segments.some((s) => s.text.trim()) ? '已收到文字' : '等待回傳'}
      </p>
      {error && (
        <p className="notice error" id="connection-error" role="alert">
          {error}
        </p>
      )}
      <section className="connection-transcript" aria-label="測試辨識文字" aria-live="polite">
        <h3>辨識文字 {segments.some((s) => s.final && s.text.trim()) ? '· 已完成辨識' : ''}</h3>
        {!segments.length ? (
          <p className="help">尚未收到辨識文字；開始後對裝置說話，再稍作停頓。</p>
        ) : (
          segments.map((s) => (
            <p className={s.final ? 'final' : 'partial'} key={s.id}>
              {s.text}
              <span>{s.final ? '（完成）' : '（辨識中）'}</span>
            </p>
          ))
        )}
      </section>
    </div>
  );
}
