import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./menu-position";

const W = 625;
const H = 560;
const MW = 176;
const MH = 56;

describe("clampMenuPosition", () => {
  it("游標在內部：照游標位置", () => {
    expect(clampMenuPosition(100, 120, MW, MH, W, H)).toEqual({ left: 100, top: 120 });
  });

  it("右緣：選單右邊不會超出舞台（舊的固定 520 在 625px 寬時會超出 72px）", () => {
    const p = clampMenuPosition(W - 10, 100, MW, MH, W, H);
    expect(p.left + MW).toBeLessThanOrEqual(W - 4);
    expect(p.left).toBe(W - MW - 4);
  });

  it("下緣：選單底部不會超出舞台", () => {
    const p = clampMenuPosition(100, H - 5, MW, MH, W, H);
    expect(p.top + MH).toBeLessThanOrEqual(H - 4);
  });

  it("右下角：兩個方向都夾住", () => {
    const p = clampMenuPosition(W, H, MW, MH, W, H);
    expect(p).toEqual({ left: W - MW - 4, top: H - MH - 4 });
  });

  it("寬舞台不受影響（不會被固定上限拉回）", () => {
    expect(clampMenuPosition(900, 100, MW, MH, 1200, 600)).toEqual({ left: 900, top: 100 });
  });

  it("負座標被拉回 margin", () => {
    expect(clampMenuPosition(-50, -20, MW, MH, W, H)).toEqual({ left: 4, top: 4 });
  });

  it("舞台比選單還小：左上角貼齊 margin（優先保證左/上可見）", () => {
    expect(clampMenuPosition(50, 50, MW, MH, 100, 40)).toEqual({ left: 4, top: 4 });
  });

  it("非有限值不產生 NaN", () => {
    const p = clampMenuPosition(NaN, Infinity, MW, MH, W, H);
    expect(Number.isFinite(p.left) && Number.isFinite(p.top)).toBe(true);
  });
});
