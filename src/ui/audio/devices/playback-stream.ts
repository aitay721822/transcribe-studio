export async function openPlaybackStream(deviceId: string): Promise<MediaStream> {
  const id = crypto.randomUUID();
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let stream: MediaStream | undefined;
  let failure = '';
  let stopped = false;
  const pending: Float32Array[] = [];

  const unsubscribe = window.studio.on('media:playback', (event) => {
    if (event.id !== id || stopped) return;
    if (event.type === 'error') {
      failure = event.message;
      stream?.getTracks().forEach((track) => {
        track.stop();
        track.dispatchEvent(new Event('ended'));
      });
      return;
    }
    const bytes = new Uint8Array(event.samples);
    const samples = new Float32Array(bytes.buffer);
    if (node) node.port.postMessage(samples, [samples.buffer]);
    else {
      if (pending.length >= 100) pending.shift();
      pending.push(samples);
    }
  });

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    node?.disconnect();
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    void window.studio.invoke('media:playback-stop', id).catch(() => {});
  };

  try {
    const { sampleRate } = await window.studio.invoke('media:playback-start', id, deviceId);
    context = new AudioContext({ sampleRate });
    await context.audioWorklet.addModule('./audio/devices/playback-worklet.js');
    if (failure) throw new Error(failure);
    node = new AudioWorkletNode(context, 'studio-playback', { outputChannelCount: [1] });
    const destination = context.createMediaStreamDestination();
    node.connect(destination);
    stream = destination.stream;
    for (const track of stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        cleanup();
      };
    }
    for (const samples of pending) node.port.postMessage(samples, [samples.buffer]);
    pending.length = 0;
    await context.resume();
    if (failure) throw new Error(failure);
    return stream;
  } catch (error) {
    cleanup();
    throw error;
  }
}
