import { FIXED_DT_MS } from "./physics";

/**
 * requestAnimationFrame 迴圈控制器：
 * - 任何時刻最多只有一個待處理的 rAF（kick 重複呼叫不會產生第二個迴圈）；
 * - dispose() 取消待處理的 rAF 並讓之後的 kick 無效（React StrictMode 的 mount → unmount → mount
 *   會建立新的 FrameLoop，舊的已 dispose，因此不會留下第二個迴圈）；
 * - step 回傳 false（模擬休眠且沒有待繪製變更）時迴圈自行停止，之後由 kick() 重新啟動。
 */
export interface FrameScheduler {
  request(cb: (t: number) => void): number;
  cancel(id: number): void;
}

export const browserScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

export class FrameLoop {
  private id: number | null = null;
  private last = 0;
  private disposed = false;
  private inFrame = false;
  private again = false;

  constructor(
    /** 每個 frame 呼叫；回傳是否需要下一個 frame */
    private readonly step: (dtMs: number, now: number) => boolean,
    private readonly scheduler: FrameScheduler = browserScheduler,
  ) {}

  get running(): boolean {
    return this.id !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 確保有一個 frame 排程中（已在跑則不做事）。
   * 在 frame callback 內呼叫時只記下「還要再一個 frame」，不會多排一個 rAF（否則同一個 frame 會排出兩個 callback）。
   */
  kick(): void {
    if (this.disposed) return;
    if (this.inFrame) {
      this.again = true;
      return;
    }
    if (this.id !== null) return;
    this.id = this.scheduler.request(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    if (this.id !== null) this.scheduler.cancel(this.id);
    this.id = null;
  }

  private frame = (t: number): void => {
    this.id = null;
    if (this.disposed) return;
    const dt = this.last > 0 ? t - this.last : FIXED_DT_MS;
    this.last = t;
    this.inFrame = true;
    this.again = false;
    let keepGoing = false;
    try {
      keepGoing = this.step(dt, t);
    } finally {
      this.inFrame = false;
    }
    if ((keepGoing || this.again) && !this.disposed) this.id = this.scheduler.request(this.frame);
    else this.last = 0; // 停止後重啟時，第一個 frame 不要吃到很大的 dt
  };
}
