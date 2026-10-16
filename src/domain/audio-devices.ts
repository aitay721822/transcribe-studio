export interface InputDevice {
  id: string;
  label: string;
  name?: string;
  named?: boolean;
  role?: 'input' | 'default' | 'communications';
  isDefault?: boolean;
  isCommunications?: boolean;
}

export interface PlaybackDevice {
  id: string;
  label: string;
  isDefault?: boolean;
  muted?: boolean;
  volume?: number;
}

export type PlaybackEvent =
  | { id: string; type: 'audio'; samples: Uint8Array }
  | { id: string; type: 'error'; message: string };

export function selectedSource(playback: string, microphone: string): string {
  if (playback === 'none') return microphone === 'none' ? 'none' : 'mic';
  return microphone === 'none' ? 'system' : 'both';
}

export function cleanDeviceName(label: string): string {
  return label.replace(/^(?:Default|Communications|預設|默认|通訊|通信)\s*[-–—:：]\s*/i, '').trim();
}

export function inputDeviceCatalog(
  raw: Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'groupId' | 'label'>[],
  active?: { deviceId?: string; label?: string }
): InputDevice[] {
  const inputs = raw.filter((d) => d.kind === 'audioinput');
  const defaultRoute = inputs.find((d) => d.deviceId === 'default');
  const communications = inputs.find((d) => d.deviceId === 'communications');
  const seen = new Set<string>();
  const physical = inputs.filter((d) => {
    if (!d.deviceId || ['default', 'communications'].includes(d.deviceId) || seen.has(d.deviceId))
      return false;
    seen.add(d.deviceId);
    return true;
  });

  const routeName = (route?: (typeof inputs)[number], fallback?: string) => {
    const device = physical.find((d) => route?.groupId && route.groupId === d.groupId);
    return device?.label?.trim() || cleanDeviceName(route?.label || '') || fallback || '';
  };

  const activeDevice = physical.find((d) => d.deviceId === active?.deviceId);
  const defaultName = routeName(
    defaultRoute,
    activeDevice?.label || cleanDeviceName(active?.label || '')
  );
  const items: InputDevice[] = [
    {
      id: '',
      label: defaultName ? `系統預設 · ${defaultName}` : '系統預設麥克風（尚未取得名稱）',
      name: defaultName,
      named: !!defaultName,
      role: 'default',
    },
  ];
  const counts = new Map<string, number>(),
    numbers = new Map<string, number>();
  for (const device of physical)
    if (device.label.trim())
      counts.set(device.label.trim(), (counts.get(device.label.trim()) || 0) + 1);
  physical.forEach((d, i) => {
    const name = d.label.trim(),
      number = (numbers.get(name) || 0) + 1;
    numbers.set(name, number);
    items.push({
      id: d.deviceId,
      label: name
        ? `${name}${(counts.get(name) || 0) > 1 ? `（同名裝置 ${number}）` : ''}`
        : `未提供名稱的麥克風 ${i + 1}`,
      name,
      named: !!name,
      role: 'input',
      isDefault:
        !!(defaultRoute?.groupId && defaultRoute.groupId === d.groupId) ||
        d.deviceId === active?.deviceId,
      isCommunications: !!(communications?.groupId && communications.groupId === d.groupId),
    });
  });
  if (communications) {
    const name = routeName(communications);
    items.push({
      id: 'communications',
      label: name ? `通訊預設 · ${name}` : '通訊預設麥克風（尚未取得名稱）',
      name,
      named: !!name,
      role: 'communications',
    });
  }
  return items;
}
