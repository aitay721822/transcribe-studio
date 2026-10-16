import { useRef, useState } from 'react';
import { duration } from '../../components/display';
import { icon } from '../../components/icons';
import { Button } from '../../primitives/button';
import { Select } from '../../primitives/select';
import { Slider } from '../../primitives/slider';

export function RecordingPlayer({
  recordingId,
  src,
  seconds = 0,
}: {
  recordingId: string;
  src: string;
  seconds?: number;
}) {
  const media = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const [length, setLength] = useState(seconds);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState('1');
  const [error, setError] = useState('');

  function loaded(audio: HTMLAudioElement) {
    if (Number.isFinite(audio.duration) && audio.duration > 0) setLength(audio.duration);
    setReady(true);
    setError('');
  }

  function seek(value: number) {
    const audio = media.current;
    if (!audio) return;
    setPosition(value);
    if (audio.seeking) pendingSeek.current = value;
    else audio.currentTime = value;
  }

  async function togglePlayback() {
    const audio = media.current;
    if (!audio || pending) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    setPending(true);
    setError('');
    try {
      for (const other of document.querySelectorAll<HTMLAudioElement>('audio[data-audio-id]')) {
        if (other !== audio) other.pause();
      }
      await audio.play();
    } catch {
      setError('無法播放這段錄音，請確認檔案仍存在且格式可播放。');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="recording-player" role="group" aria-label="錄音播放控制">
      <audio
        ref={media}
        className="audio-player"
        data-audio-id={recordingId}
        hidden
        preload="metadata"
        src={src}
        onLoadedMetadata={(event) => loaded(event.currentTarget)}
        onDurationChange={(event) => loaded(event.currentTarget)}
        onTimeUpdate={(event) => {
          if (pendingSeek.current === null) setPosition(event.currentTarget.currentTime);
        }}
        onSeeked={(event) => {
          const next = pendingSeek.current;
          pendingSeek.current = null;
          if (next !== null) event.currentTarget.currentTime = next;
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onRateChange={(event) => setRate(String(event.currentTarget.playbackRate))}
        onError={() => {
          pendingSeek.current = null;
          setPlaying(false);
          setReady(false);
          setError('無法播放這段錄音，請確認檔案仍存在且格式可播放。');
        }}
      />
      <div className="recording-player-heading">
        <Button
          variant="outline"
          size="icon"
          className="btn recording-play-toggle"
          aria-label={playing ? '暫停錄音' : '播放錄音'}
          aria-busy={pending}
          disabled={pending || !!error}
          onClick={() => void togglePlayback()}
        >
          {icon(playing ? 'pause' : 'play')}
        </Button>
        <span className="recording-player-time" aria-label="播放時間">
          {duration(position)} / {duration(length)}
        </span>
        <Select
          aria-label="播放速度"
          value={rate}
          disabled={!!error}
          onChange={(event) => {
            setRate(event.target.value);
            if (media.current) media.current.playbackRate = Number(event.target.value);
          }}
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </Select>
      </div>
      <Slider
        aria-label="錄音播放位置"
        formatValue={(value) => `${duration(value)}，共 ${duration(length)}`}
        value={[Math.min(position, length)]}
        min={0}
        max={length || 1}
        step={0.1}
        disabled={!ready || !length || !!error}
        onValueChange={([value = 0]) => {
          seek(value);
        }}
      />
      <div className="recording-player-volume">
        <Button
          variant="ghost"
          size="sm"
          className="btn text small"
          aria-label={muted || volume === 0 ? '取消靜音' : '靜音'}
          aria-pressed={muted || volume === 0}
          disabled={!!error}
          onClick={() => {
            if (!media.current) return;
            const next = !(muted || volume === 0);
            if (volume === 0) {
              media.current.volume = 1;
              setVolume(1);
            }
            media.current.muted = next;
            setMuted(next);
          }}
        >
          {icon('wave')}
          {muted || volume === 0 ? '取消靜音' : '靜音'}
        </Button>
        <Slider
          aria-label="錄音播放音量"
          formatValue={(value) => `${value}%`}
          value={[muted ? 0 : Math.round(volume * 100)]}
          min={0}
          max={100}
          step={1}
          disabled={!!error}
          onValueChange={([value = 100]) => {
            if (!media.current) return;
            media.current.muted = false;
            media.current.volume = value / 100;
            setMuted(false);
            setVolume(value / 100);
          }}
        />
        <span>{muted ? 0 : Math.round(volume * 100)}%</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
