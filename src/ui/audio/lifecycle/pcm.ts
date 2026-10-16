export function flushPcm(worklet?: AudioWorkletNode, context?: AudioContext): Promise<void> {
  if (!worklet || context?.state !== 'running') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      worklet.port.removeEventListener('message', received);
      resolve();
    };

    const received = (event: MessageEvent) => {
      if (event.data?.flushed) finish();
    };

    const timer = setTimeout(finish, 500);
    worklet.port.addEventListener('message', received);
    worklet.port.postMessage({ flush: true });
  });
}
