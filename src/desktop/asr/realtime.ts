import { z } from 'zod';
import { failureInfo } from '../../domain/asr/retry';
import { taskFailure } from '../../domain/asr/tasks';
import { RecoveringRealtimeSession } from '../../services/asr/realtime/session';
import { normalize } from '../../transport/asr';
import { signalOffer } from '../../transport/webrtc';
import type { DesktopContext } from '../context';

export function registerRealtime(ctx: DesktopContext): void {
  const action = z.enum(['retry', 'pause', 'resume', 'reconfigure']);

  const session = (id: string) => {
    const current = ctx.asr.get(id);
    if (!(current instanceof RecoveringRealtimeSession))
      throw new Error('此會議沒有可管理的即時連線');
    return current;
  };

  ctx.handle('asr:connections', () =>
    [...ctx.asr.values()].flatMap((current) =>
      current instanceof RecoveringRealtimeSession ? [current.status()] : []
    )
  );
  ctx.handle('asr:connection-action', (id, value) => session(id).action(action.parse(value)));
  ctx.handle('asr:online', () => {
    for (const current of ctx.asr.values())
      if (
        current instanceof RecoveringRealtimeSession &&
        current.status().state === 'waiting_retry'
      )
        current.action('retry');
    ctx.asrTasks.queue.networkRestored();
  });
  ctx.handle('rtc:config', (id, epoch) => {
    if (!session(id).current(epoch)) throw new Error('WebRTC 連線已變更');
    const config = ctx.settingsInternal().asr;
    return {
      provider: 'webrtc',
      sampleRate: config.sampleRate,
      channel: config.channel,
      iceServers: config.iceServers,
    };
  });
  ctx.handle('rtc:state', (id, epoch, connected, failure) => {
    session(id).rtcState(
      z.number().int().parse(epoch),
      z.boolean().parse(connected),
      failure ? taskFailure.parse(failure) : undefined
    );
  });
  ctx.handle('rtc:signal', async (id, offer, epoch) => {
    const current = session(id);
    if (epoch === undefined || !current.current(epoch)) throw new Error('WebRTC 連線已變更');
    try {
      const result = await signalOffer(ctx.settingsInternal().asr, offer);
      if (!current.current(epoch)) throw new Error('WebRTC 連線已變更');
      return result;
    } catch (error) {
      current.rtcState(epoch, false, failureInfo(error));
      throw error;
    }
  });
  ctx.handle('rtc:event', (id, data, elapsed, epoch) => {
    const current = session(id);
    if (epoch === undefined || !current.current(epoch)) return;
    if (!ctx.rtcCaches.has(id)) ctx.rtcCaches.set(id, new Map());
    const segment = normalize(
      data,
      ctx.settingsInternal().asr,
      elapsed - current.origin(),
      ctx.rtcCaches.get(id)
    );
    if (segment) current.receive({ type: 'segment', segment }, epoch);
  });
}
