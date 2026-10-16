import { useEffect, useRef, useState } from 'react';
import { VolumeMeter } from '../meter';

export function AudioMeter({
  source,
  deviceId,
  ready,
}: {
  source: string;
  deviceId: string;
  ready: () => Promise<void>;
}) {
  const bars = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('正在取得音訊來源…');
  useEffect(() => {
    const meter = new VolumeMeter();
    let alive = true;
    void meter
      .start(
        source,
        deviceId,
        [...bars.current.querySelectorAll<HTMLElement>('.meter-bar')],
        (message) => {
          if (alive) setStatus(message);
        }
      )
      .then(() => {
        if (alive) void ready();
      });
    return () => {
      alive = false;
      meter.stop();
    };
  }, [source, deviceId]);
  return (
    <>
      <div className="help">僅測試音量，不錄音、不連線 ASR。</div>
      <div className="level-bars" id="test-level" ref={bars}>
        {Array.from(
          {
            length: 40,
          },
          (_, i) => (
            <span className="meter-bar" key={i} />
          )
        )}
      </div>
      <div id="test-label" className="help">
        {status}
      </div>
    </>
  );
}
