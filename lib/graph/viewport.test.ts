import { describe, expect, it } from "vitest";
import {
  FIT_MAX_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  boundsOf,
  clampZoom,
  fitToView,
  identityViewport,
  normalizeWheelDelta,
  panBy,
  screenToWorld,
  wheelFactor,
  worldToScreen,
  zoomAt,
  type Viewport,
} from "./viewport";

const vp: Viewport = { panX: 120, panY: -40, zoom: 1.7 };

describe("viewport 座標轉換", () => {
  it("worldToScreen 與 screenToWorld 互為反函數", () => {
    for (const [x, y] of [[0, 0], [100, -250], [-3.3, 8.8], [1e5, -1e5]]) {
      const s = worldToScreen(vp, x, y);
      const w = screenToWorld(vp, s.x, s.y);
      expect(w.x).toBeCloseTo(x, 6);
      expect(w.y).toBeCloseTo(y, 6);
    }
  });

  it("panBy 平移 screen 位置，zoom 不變；非有限值被忽略", () => {
    const p = panBy(vp, 30, -10);
    expect(p).toEqual({ panX: 150, panY: -50, zoom: 1.7 });
    expect(panBy(vp, NaN, 1)).toBe(vp);
  });
});

describe("cursor-centered zoom", () => {
  it("游標下方的 world 點在縮放前後保持在同一個 screen 位置", () => {
    for (const [cx, cy, f] of [[300, 200, 1.2], [10, 10, 0.5], [640, 480, 2.5], [0, 0, 1.01]]) {
      const before = screenToWorld(vp, cx, cy);
      const next = zoomAt(vp, cx, cy, f);
      const after = worldToScreen(next, before.x, before.y);
      expect(after.x).toBeCloseTo(cx, 6);
      expect(after.y).toBeCloseTo(cy, 6);
    }
  });

  it("zoom 被夾在 [MIN_ZOOM, MAX_ZOOM]，夾住時游標仍然是中心", () => {
    let v = vp;
    for (let i = 0; i < 100; i++) v = zoomAt(v, 400, 300, 1.5);
    expect(v.zoom).toBe(MAX_ZOOM);
    const w = screenToWorld(v, 400, 300);
    const out = zoomAt(v, 400, 300, 2);
    expect(out.zoom).toBe(MAX_ZOOM);
    expect(worldToScreen(out, w.x, w.y).x).toBeCloseTo(400, 6);
    for (let i = 0; i < 200; i++) v = zoomAt(v, 400, 300, 0.5);
    expect(v.zoom).toBe(MIN_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
  });

  it("非法的 factor / 游標座標回傳原 viewport，不產生 NaN", () => {
    expect(zoomAt(vp, 1, 1, NaN)).toBe(vp);
    expect(zoomAt(vp, 1, 1, 0)).toBe(vp);
    expect(zoomAt(vp, 1, 1, -2)).toBe(vp);
    expect(zoomAt(vp, NaN, 1, 2)).toBe(vp);
  });

  it("wheel：向下滾（deltaY > 0）縮小、向上滾放大；正反滾動互為反函數；deltaMode 正規化", () => {
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100) * wheelFactor(-100)).toBeCloseTo(1, 10);
    expect(Number.isFinite(wheelFactor(1e9))).toBe(true);
    expect(normalizeWheelDelta(3, 1, 800)).toBe(48);
    expect(normalizeWheelDelta(1, 2, 800)).toBe(800);
    expect(normalizeWheelDelta(7, 0, 800)).toBe(7);
    expect(normalizeWheelDelta(NaN, 0, 800)).toBe(0);
  });
});

describe("fit-to-view", () => {
  const size = { w: 900, h: 600 };
  const nodes = [
    { x: -300, y: -100, r: 20 },
    { x: 500, y: 250, r: 15 },
    { x: 100, y: -400, r: 10 },
  ];

  it("所有節點（含半徑）完整落在畫面內並保留 padding，且置中", () => {
    const b = boundsOf(nodes)!;
    const v = fitToView(b, size, 40);
    const tl = worldToScreen(v, b.minX, b.minY);
    const br = worldToScreen(v, b.maxX, b.maxY);
    expect(tl.x).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(tl.y).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(br.x).toBeLessThanOrEqual(size.w - 40 + 1e-6);
    expect(br.y).toBeLessThanOrEqual(size.h - 40 + 1e-6);
    expect((tl.x + br.x) / 2).toBeCloseTo(size.w / 2, 6);
    expect((tl.y + br.y) / 2).toBeCloseTo(size.h / 2, 6);
  });

  it("節點很少時不放大到超過 FIT_MAX_ZOOM", () => {
    const v = fitToView(boundsOf([{ x: 0, y: 0, r: 10 }]), size);
    expect(v.zoom).toBe(FIT_MAX_ZOOM);
    expect(worldToScreen(v, 0, 0)).toEqual({ x: size.w / 2, y: size.h / 2 });
  });

  it("很大的圖會縮小，但不低於 MIN_ZOOM", () => {
    const v = fitToView(boundsOf([{ x: -1e6, y: 0, r: 10 }, { x: 1e6, y: 0, r: 10 }]), size);
    expect(v.zoom).toBe(MIN_ZOOM);
  });

  it("沒有節點 / 尺寸為 0 時回傳置中的 identity，不產生 NaN", () => {
    expect(boundsOf([])).toBeNull();
    expect(fitToView(null, size)).toEqual(identityViewport(size));
    const z = fitToView(boundsOf(nodes), { w: 0, h: 0 });
    expect(Object.values(z).every(Number.isFinite)).toBe(true);
    const tiny = fitToView(boundsOf(nodes), { w: 10, h: 10 }, 56);
    expect(Object.values(tiny).every(Number.isFinite)).toBe(true);
  });

  it("boundsOf 忽略非有限座標", () => {
    expect(boundsOf([{ x: NaN, y: 0, r: 1 }, { x: 5, y: 5, r: 2 }])).toEqual({ minX: 3, minY: 3, maxX: 7, maxY: 7 });
  });
});
