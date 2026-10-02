import { describe, expect, it } from "vitest";
import { FrameLoop, type FrameScheduler } from "./frame-loop";

/** 假的 rAF：手動推進，並追蹤目前排程中的 callback 數量。 */
function fakeScheduler() {
  let nextId = 1;
  const pending = new Map<number, (t: number) => void>();
  const scheduler: FrameScheduler = {
    request: (cb) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancel: (id) => void pending.delete(id),
  };
  const flush = (t: number) => {
    const cbs = [...pending.values()];
    pending.clear();
    cbs.forEach((cb) => cb(t));
  };
  return { scheduler, pending, flush };
}

describe("FrameLoop", () => {
  it("kick 重複呼叫只會有一個待處理的 frame（不會產生第二個迴圈）", () => {
    const f = fakeScheduler();
    const loop = new FrameLoop(() => true, f.scheduler);
    loop.kick();
    loop.kick();
    loop.kick();
    expect(f.pending.size).toBe(1);
    f.flush(16);
    expect(f.pending.size).toBe(1); // 一個 frame 跑完，只排下一個
  });

  it("step 回傳 false 時迴圈停止；之後 kick 可重新啟動", () => {
    const f = fakeScheduler();
    let keep = true;
    let calls = 0;
    const loop = new FrameLoop(() => (calls++, keep), f.scheduler);
    loop.kick();
    f.flush(16);
    keep = false;
    f.flush(32);
    expect(loop.running).toBe(false);
    expect(f.pending.size).toBe(0);
    const before = calls;
    f.flush(48);
    expect(calls).toBe(before);
    loop.kick();
    expect(f.pending.size).toBe(1);
  });

  it("dispose 取消待處理的 frame；dispose 後 kick 無效、callback 不再執行", () => {
    const f = fakeScheduler();
    let calls = 0;
    const loop = new FrameLoop(() => (calls++, true), f.scheduler);
    loop.kick();
    loop.dispose();
    expect(f.pending.size).toBe(0);
    loop.kick();
    expect(f.pending.size).toBe(0);
    f.flush(16);
    expect(calls).toBe(0);
    expect(loop.isDisposed).toBe(true);
  });

  it("React StrictMode 模擬（mount → cleanup → mount）：任何時刻只有一個迴圈在跑", () => {
    const f = fakeScheduler();
    const ticks: string[] = [];
    // mount #1
    const first = new FrameLoop(() => (ticks.push("first"), true), f.scheduler);
    first.kick();
    // StrictMode 立刻 cleanup
    first.dispose();
    // mount #2
    const second = new FrameLoop(() => (ticks.push("second"), true), f.scheduler);
    second.kick();
    expect(f.pending.size).toBe(1);
    f.flush(16);
    f.flush(32);
    expect(ticks).toEqual(["second", "second"]);
    expect(f.pending.size).toBe(1);
    second.dispose();
    expect(f.pending.size).toBe(0);
  });

  it("frame 進行中被 dispose：不會再排下一個 frame", () => {
    const f = fakeScheduler();
    let loop!: FrameLoop;
    loop = new FrameLoop(() => {
      loop.dispose();
      return true;
    }, f.scheduler);
    loop.kick();
    f.flush(16);
    expect(f.pending.size).toBe(0);
  });

  it("在 frame callback 內 kick：只會有一個下一個 frame（不會排出第二個 rAF）；step 回傳 false 但有 kick 時仍會再跑一個 frame", () => {
    const f = fakeScheduler();
    let calls = 0;
    const loop = new FrameLoop(() => {
      calls++;
      loop.kick(); // 例如 controller 在 tick 內觸發 invalidate
      loop.kick();
      return true;
    }, f.scheduler);
    loop.kick();
    f.flush(16);
    expect(f.pending.size).toBe(1);

    const g = fakeScheduler();
    let n = 0;
    const once = new FrameLoop(() => {
      n++;
      if (n === 1) once.kick();
      return false;
    }, g.scheduler);
    once.kick();
    g.flush(16);
    expect(g.pending.size).toBe(1); // 雖然回傳 false，但 frame 內有 kick → 再跑一個
    g.flush(32);
    expect(g.pending.size).toBe(0);
    expect(n).toBe(2);
    expect(calls).toBe(1);
  });

  it("step 丟例外：inFrame 旗標會被還原，之後 kick 仍可正常運作", () => {
    const f = fakeScheduler();
    let boom = true;
    const loop = new FrameLoop(() => {
      if (boom) throw new Error("boom");
      return false;
    }, f.scheduler);
    loop.kick();
    expect(() => f.flush(16)).toThrow("boom");
    boom = false;
    loop.kick();
    expect(f.pending.size).toBe(1);
  });

  it("dt：首個 frame 使用固定步長；之後為實際間隔；停止後重啟又回到固定步長（不吃到巨大 dt）", () => {
    const f = fakeScheduler();
    const dts: number[] = [];
    let keep = true;
    const loop = new FrameLoop((dt) => (dts.push(dt), keep), f.scheduler);
    loop.kick();
    f.flush(1000);
    f.flush(1033);
    keep = false;
    f.flush(1050);
    keep = true;
    loop.kick();
    f.flush(9000); // 久後重啟
    expect(dts[0]).toBeCloseTo(1000 / 60, 6);
    expect(dts[1]).toBe(33);
    expect(dts[2]).toBe(17);
    expect(dts[3]).toBeCloseTo(1000 / 60, 6);
  });
});
