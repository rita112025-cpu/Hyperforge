import { describe, expect, it } from "vitest";
import { circleIntersectsRect, hitNodeAt, nodesInRect, normalizeRect, pointInShape, type HitSet } from "./hit";
import type { NodeShape } from "./types";

function set(items: Array<{ x: number; y: number; r: number; shape?: NodeShape }>): HitSet {
  return {
    count: items.length,
    x: items.map((i) => i.x),
    y: items.map((i) => i.y),
    r: items.map((i) => i.r),
    shape: items.map((i) => i.shape ?? "circle"),
  };
}

describe("pointInShape（shape-aware）", () => {
  it("circle：邊界內外", () => {
    expect(pointInShape("circle", 9.99, 0, 10)).toBe(true);
    expect(pointInShape("circle", 10.01, 0, 10)).toBe(false);
    expect(pointInShape("circle", 7, 7, 10)).toBe(true); // |p| = 9.9
    expect(pointInShape("circle", 7.2, 7.2, 10)).toBe(false);
  });

  it("diamond：菱形角落外、但仍在外接圓內的點不算命中", () => {
    expect(pointInShape("diamond", 0, 9.9, 10)).toBe(true);
    expect(pointInShape("diamond", 4.9, 4.9, 10)).toBe(true);
    expect(pointInShape("diamond", 6, 6, 10)).toBe(false); // 在圓內（|p|=8.5）但不在菱形內
    expect(pointInShape("circle", 6, 6, 10)).toBe(true);
  });

  it("hexagon：頂點在左右；上下為平邊（高度 r·√3/2）", () => {
    expect(pointInShape("hexagon", 9.9, 0, 10)).toBe(true);
    expect(pointInShape("hexagon", 0, 8.6, 10)).toBe(true);
    expect(pointInShape("hexagon", 0, 9.5, 10)).toBe(false); // 在圓內但超出平邊
    expect(pointInShape("circle", 0, 9.5, 10)).toBe(true);
    expect(pointInShape("hexagon", 9, 4, 10)).toBe(false); // 斜邊外
    expect(pointInShape("hexagon", 5, 8.6, 10)).toBe(true); // 頂點附近
  });

  it("三種形狀皆對稱（四象限結果一致）", () => {
    for (const shape of ["circle", "diamond", "hexagon"] as const) {
      for (const [dx, dy] of [[3, 4], [7, 2], [9, 1], [1, 9]]) {
        const v = pointInShape(shape, dx, dy, 10);
        expect(pointInShape(shape, -dx, dy, 10)).toBe(v);
        expect(pointInShape(shape, dx, -dy, 10)).toBe(v);
        expect(pointInShape(shape, -dx, -dy, 10)).toBe(v);
      }
    }
  });
});

describe("hitNodeAt", () => {
  it("命中最上層（索引最大）的節點；沒命中回傳 -1；空集合回傳 -1", () => {
    const s = set([
      { x: 0, y: 0, r: 20 },
      { x: 10, y: 0, r: 20 },
    ]);
    expect(hitNodeAt(s, 5, 0)).toBe(1);
    expect(hitNodeAt(s, -15, 0)).toBe(0);
    expect(hitNodeAt(s, 100, 100)).toBe(-1);
    expect(hitNodeAt(set([]), 0, 0)).toBe(-1);
  });

  it("slop 擴大命中範圍", () => {
    const s = set([{ x: 0, y: 0, r: 10 }]);
    expect(hitNodeAt(s, 12, 0)).toBe(-1);
    expect(hitNodeAt(s, 12, 0, 3)).toBe(0);
  });

  it("形狀感知：點在菱形外接圓內但菱形外 → 穿透到下層節點", () => {
    const s = set([
      { x: 0, y: 0, r: 30, shape: "circle" }, // 下層
      { x: 0, y: 0, r: 20, shape: "diamond" }, // 上層
    ]);
    expect(hitNodeAt(s, 0, 15)).toBe(1); // 菱形內
    expect(hitNodeAt(s, 12, 12)).toBe(0); // 菱形外（|dx|+|dy|=24>20）→ 命中下層圓
  });
});

describe("box selection", () => {
  const s = set([
    { x: 0, y: 0, r: 10 },
    { x: 100, y: 0, r: 10 },
    { x: 100, y: 100, r: 10 },
    { x: -100, y: -100, r: 10 },
    { x: 300, y: 300, r: 10 },
  ]);

  it("normalizeRect：四個拖曳方向得到相同矩形", () => {
    const expected = { x0: 10, y0: 20, x1: 50, y1: 80 };
    expect(normalizeRect(10, 20, 50, 80)).toEqual(expected); // 左上 → 右下
    expect(normalizeRect(50, 80, 10, 20)).toEqual(expected); // 右下 → 左上
    expect(normalizeRect(50, 20, 10, 80)).toEqual(expected); // 右上 → 左下
    expect(normalizeRect(10, 80, 50, 20)).toEqual(expected); // 左下 → 右上
  });

  it("正向與反向拖曳選到相同節點", () => {
    const fwd = nodesInRect(s, normalizeRect(-50, -50, 150, 150));
    const rev = nodesInRect(s, normalizeRect(150, 150, -50, -50));
    const mixed = nodesInRect(s, normalizeRect(150, -50, -50, 150));
    expect(fwd).toEqual([0, 1, 2]);
    expect(rev).toEqual(fwd);
    expect(mixed).toEqual(fwd);
  });

  it("只碰到節點邊緣（圓與矩形相交）也算選到；完全在外則否", () => {
    expect(nodesInRect(s, normalizeRect(105, -5, 200, 5))).toEqual([1]); // 矩形左緣在節點圓內
    expect(nodesInRect(s, normalizeRect(111, -5, 200, 5))).toEqual([]); // 距節點邊緣 1
  });

  it("矩形完全在大節點內部時也選到該節點", () => {
    const big = set([{ x: 0, y: 0, r: 100 }]);
    expect(nodesInRect(big, normalizeRect(-5, -5, 5, 5))).toEqual([0]);
  });

  it("零面積矩形（點）只選到包含該點的節點", () => {
    expect(nodesInRect(s, normalizeRect(0, 0, 0, 0))).toEqual([0]);
    expect(nodesInRect(s, normalizeRect(50, 50, 50, 50))).toEqual([]);
  });

  it("circleIntersectsRect 邊界", () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(circleIntersectsRect(15, 5, 5, r)).toBe(true);
    expect(circleIntersectsRect(15.1, 5, 5, r)).toBe(false);
    expect(circleIntersectsRect(14, 14, 5.66, r)).toBe(true); // 角落：距離 √32 ≈ 5.657
    expect(circleIntersectsRect(14, 14, 5.65, r)).toBe(false);
  });
});
