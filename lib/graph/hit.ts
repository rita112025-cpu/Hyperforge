import type { NodeShape } from "./types";

/**
 * Hit testing（純函式，world 座標）。節點以 struct-of-arrays 傳入，可直接使用 physics 狀態的陣列。
 * 陣列索引越大 = 越晚繪製 = 越上層，hit 時由上往下找。
 */
export interface HitSet {
  count: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  r: ArrayLike<number>;
  shape: ReadonlyArray<NodeShape>;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const SQRT3_2 = Math.sqrt(3) / 2;

/**
 * 點 (dx, dy)（相對節點中心）是否落在形狀內。形狀的外接圓半徑皆為 r：
 * circle = 圓；diamond = 內接於該圓的菱形（|dx|+|dy| ≤ r）；hexagon = 外接圓半徑 r、頂點在左右的正六邊形。
 * 所以菱形、六邊形的角落處「點到圓邊但不在形狀內」不會被判為命中（shape-aware）。
 */
export function pointInShape(shape: NodeShape, dx: number, dy: number, r: number): boolean {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  switch (shape) {
    case "circle":
      return dx * dx + dy * dy <= r * r;
    case "diamond":
      return ax + ay <= r;
    case "hexagon":
      return ay <= r * SQRT3_2 && ax * SQRT3_2 + ay * 0.5 <= r * SQRT3_2;
  }
}

/** 回傳命中的最上層節點索引；沒有則 -1。slop（world 單位）為額外容許的命中半徑（螢幕上固定像素 / zoom）。 */
export function hitNodeAt(set: HitSet, wx: number, wy: number, slop = 0): number {
  for (let i = set.count - 1; i >= 0; i--) {
    if (pointInShape(set.shape[i], wx - set.x[i], wy - set.y[i], set.r[i] + slop)) return i;
  }
  return -1;
}

/** 任意方向拖曳得到的兩個角點 → 正規化矩形（x0≤x1、y0≤y1）。 */
export function normalizeRect(ax: number, ay: number, bx: number, by: number): Rect {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export function circleIntersectsRect(cx: number, cy: number, r: number, rect: Rect): boolean {
  const nx = Math.min(Math.max(cx, rect.x0), rect.x1);
  const ny = Math.min(Math.max(cy, rect.y0), rect.y1);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/** 與矩形相交的節點索引（升冪）。以節點外接圓判斷；矩形需已正規化（用 normalizeRect）。 */
export function nodesInRect(set: HitSet, rect: Rect): number[] {
  const out: number[] = [];
  for (let i = 0; i < set.count; i++) if (circleIntersectsRect(set.x[i], set.y[i], set.r[i], rect)) out.push(i);
  return out;
}
