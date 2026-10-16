import type { InputDevice } from '../../../domain/audio-devices';
import { Select } from '../../primitives/select';
import { AudioPermissions, useMediaPermissions } from './permissions';

export function DevicePicker({
  id,
  devices,
  value,
  disabled,
  onChange,
}: {
  id: string;
  devices: InputDevice[];
  value: string;
  disabled?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  const route = devices.find((d) => d.id === '');
  const permissions = useMediaPermissions();
  return (
    <>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        onChange={onChange}
        popupWidth={440}
        wrapOptions
      >
        <optgroup label="麥克風">
          <option value="mic:">{route?.label || '系統預設麥克風（點偵測取得名稱）'}</option>
          {devices
            .filter((d) => d.role !== 'default' && d.role !== 'communications' && d.id)
            .map((d) => (
              <option key={d.id} value={`mic:${d.id}`}>
                {d.label}
              </option>
            ))}
        </optgroup>
        {devices.some((d) => d.role === 'communications') && (
          <optgroup label="通訊路由">
            {devices
              .filter((d) => d.role === 'communications')
              .map((d) => (
                <option key={d.id} value={`mic:${d.id}`}>
                  {d.label}
                </option>
              ))}
          </optgroup>
        )}
        <optgroup label="電腦播放音訊">
          <option value="system" disabled={permissions?.systemAudio === false}>
            系統音訊（預設播放裝置）
          </option>
          <option value="both" disabled={permissions?.systemAudio === false}>
            系統音訊＋選定麥克風
          </option>
        </optgroup>
      </Select>
      <AudioPermissions permissions={permissions} />
    </>
  );
}

export function DeviceDetails({
  devices,
  value,
  microphoneId = '',
  actual,
}: {
  devices: InputDevice[];
  value: string;
  microphoneId?: string;
  actual?: { label: string; sampleRate?: number; channelCount?: number };
}) {
  const device = devices.find((d) => d.id === (value === 'both' ? microphoneId : value.slice(4)));
  if (value === 'system')
    return <p className="help">擷取目前系統預設播放裝置的聲音；麥克風不會收音。</p>;

  const microphoneRoute = () => {
    if (device?.role === 'default' || !device?.id) {
      return '跟隨系統預設麥克風';
    }
    if (device.role === 'communications') {
      return '跟隨系統通訊麥克風';
    }
    return '使用指定麥克風';
  };

  return (
    <div className="device-details" aria-label="所選音訊裝置資訊">
      <strong>{actual?.label || device?.name || '裝置名稱尚未取得'}</strong>
      <p>
        {value === 'both' ? '電腦播放音訊＋' : ''}
        {microphoneRoute()}
        {device?.role === 'input' && device.isDefault ? ' · 系統預設' : ''}
        {device?.role === 'input' && device.isCommunications ? ' · 通訊預設' : ''}
        {actual?.sampleRate ? ` · 裝置取樣率 ${actual.sampleRate.toLocaleString()} Hz` : ''}
        {actual?.channelCount ? ` · ${actual.channelCount} 聲道` : ''}
      </p>
      <p className="help">
        {device?.named || actual?.label
          ? '名稱由系統與驅動提供；若僅有通用名稱，系統未提供更具體的型號。'
          : '請允許麥克風權限並偵測裝置，取得系統提供的完整名稱。'}
      </p>
    </div>
  );
}
