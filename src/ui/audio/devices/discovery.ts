import { useEffect, useRef, useState } from 'react';
import type { InputDevice } from '../sources';
import { listInputDevices } from '../sources';

export function useInputDevices(busy: boolean, initialDevices: InputDevice[] = []) {
  const [devices, setDevices] = useState<InputDevice[]>(initialDevices),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const alive = useRef(false),
    revision = useRef(0),
    busyRef = useRef(busy);
  const scanning = useRef(false),
    missedChange = useRef(false);
  busyRef.current = busy;

  async function refresh(permission = true) {
    if (busyRef.current || scanning.current) return;
    scanning.current = true;
    const request = ++revision.current;
    setLoading(true);
    setError('');
    try {
      const value = await listInputDevices(permission);
      if (alive.current && request === revision.current) setDevices(value);
    } catch (caughtE) {
      const e = caughtE instanceof Error ? caughtE : new Error(String(caughtE));

      if (alive.current && request === revision.current) {
        setError(
          e.name === 'NotAllowedError'
            ? '麥克風權限未開啟，請至系統設定允許此應用程式存取麥克風後重新偵測。'
            : e.message
        );
        const value = await listInputDevices().catch(
          (): Awaited<ReturnType<typeof listInputDevices>> => []
        );
        if (alive.current && request === revision.current) setDevices(value);
      }
    } finally {
      scanning.current = false;
      if (alive.current && request === revision.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void refresh();

    const changed = () => {
      if (busyRef.current) missedChange.current = true;
      else void refresh();
    };

    navigator.mediaDevices.addEventListener('devicechange', changed);
    return () => {
      alive.current = false;
      revision.current++;
      navigator.mediaDevices.removeEventListener('devicechange', changed);
    };
  }, []);
  useEffect(() => {
    if (!busy && missedChange.current) {
      missedChange.current = false;
      void refresh();
    }
  }, [busy]);
  return { devices, loading, error, refresh };
}
