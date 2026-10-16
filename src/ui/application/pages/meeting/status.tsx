import { useEffect, useState } from 'react';
import type { AudioCapture } from '../../../audio/capture';
import { duration as formatDuration } from '../../../components/display';

export function RecordTimer({
  capture,
  duration,
  active,
}: {
  capture: AudioCapture;
  duration: number;
  active: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <span className="timer" id="record-timer">
      {formatDuration(active ? capture.elapsed() : duration)}
    </span>
  );
}
