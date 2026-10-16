import { useEffect } from 'react';
import type { UiState } from '../../../domain/models';
import { invalidateUI } from '../../layout/roots';
import { Button } from '../../primitives/button';
import { useInputDevices } from './discovery';
import { DeviceDetails, DevicePicker } from './picker';

export function LiveDevicePicker({ state, busy }: { state: UiState; busy: boolean }) {
  const { devices, loading, error, refresh } = useInputDevices(busy, state.inputDevices);
  const value = state.source === 'mic' ? `mic:${state.microphoneId || ''}` : state.source;
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
      <label htmlFor="audio-device">裝置音量</label>
      <div className="device-picker">
        <DevicePicker
          id="audio-device"
          devices={devices}
          value={value}
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
