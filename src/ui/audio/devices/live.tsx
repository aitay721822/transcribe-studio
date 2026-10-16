import { useEffect } from 'react';
import { selectedSource } from '../../../domain/audio-devices';
import type { UiState } from '../../../domain/models';
import { invalidateUI } from '../../layout/roots';
import { Button } from '../../primitives/button';
import { useInputDevices } from './discovery';
import { DeviceDetails, DevicePicker } from './picker';

export function LiveDevicePicker({ state, busy }: { state: UiState; busy: boolean }) {
  const { devices, loading, error, refresh } = useInputDevices(busy, state.inputDevices);
  const value = state.source === 'mic' ? `mic:${state.microphoneId || ''}` : state.source;
  const playback = ['system', 'both'].includes(state.source) ? state.playbackId || '' : 'none';
  const microphone = ['system', 'none'].includes(state.source)
    ? 'none'
    : `mic:${state.microphoneId || ''}`;

  function select(nextPlayback: string, nextMicrophone: string) {
    state.source = selectedSource(nextPlayback, nextMicrophone);
    if (nextPlayback !== 'none') state.playbackId = nextPlayback;
    if (nextMicrophone !== 'none') state.microphoneId = nextMicrophone.slice(4);
    localStorage.setItem('studio.source', state.source);
    localStorage.setItem('studio.playback', state.playbackId || '');
    localStorage.setItem('studio.microphone', state.microphoneId || '');
    invalidateUI();
  }

  useEffect(() => {
    state.inputDevices = devices;
  }, [devices, state]);
  useEffect(() => {
    if (
      !loading &&
      !error &&
      !busy &&
      state.microphoneId &&
      !devices.some((d) => d.id === state.microphoneId)
    ) {
      state.microphoneId = '';
      localStorage.removeItem('studio.microphone');
      invalidateUI();
    }
  }, [devices, loading, busy, error, state]);
  return (
    <div className="field">
      <div className="device-picker">
        <DevicePicker
          id="audio-device"
          devices={devices}
          value={microphone}
          playback={playback}
          onChange={(event) => {
            event.stopPropagation();
            select(playback, event.target.value);
          }}
          onPlaybackChange={(event) => {
            event.stopPropagation();
            select(event.target.value, microphone);
          }}
          disabled={loading || busy}
        />
        <Button
          className="btn small"
          variant="outline"
          data-action="refresh-devices"
          disabled={loading || busy}
          onClick={(event) => {
            event.stopPropagation();
            void refresh();
          }}
        >
          {loading ? '正在取得名稱…' : '偵測完整裝置名稱'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <DeviceDetails devices={devices} value={value} microphoneId={state.microphoneId} />
    </div>
  );
}
