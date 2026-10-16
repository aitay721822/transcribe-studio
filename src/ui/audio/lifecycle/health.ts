/** Silence is a diagnostic hint, never a reason to stop a valid recording. */
export class AudioHealth {
  private started = Date.now();
  private heard = false;
  private warned = false;

  constructor(private warn: (message: string) => void) {}

  sample(level: number, muted = false, now = Date.now()) {
    if (level > 0.0001) this.heard = true;
    if (this.warned || now - this.started < 10000 || (this.heard && !muted)) return;
    this.warned = true;
    this.warn('尚未偵測到系統播放音訊；請播放聲音並檢查系統錄音權限。若目前安靜，可繼續錄音。');
  }
}
