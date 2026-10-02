/**
 * Viewport：world ↔ screen 轉換（純函式）。
 * screen = world * zoom + (panX, panY)；screen 單位為 canvas 的 CSS px。
 */
export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 6;
/** 「適合畫面」的最大放大倍率：節點很少時不要放大到誇張 */
export const FIT_MAX_ZOOM = 1.4;
export const FIT_PADDING_PX = 56;
/** wheel 縮放靈敏度：factor = exp(-deltaY * WHEEL_ZOOM_RATE) */
export const WHEEL_ZOOM_RATE = 0.0015;

export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : 1);

export const identityViewport = (size?: Size): Viewport => ({ panX: size ? size.w / 2 : 0, panY: size ? size.h / 2 : 0, zoom: 1 });

export function worldToScreen(vp: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * vp.zoom + vp.panX, y: wy * vp.zoom + vp.panY };
}

export function screenToWorld(vp: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - vp.panX) / vp.zoom, y: (sy - vp.panY) / vp.zoom };
}

export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return vp;
  return { ...vp, panX: vp.panX + dx, panY: vp.panY + dy };
}

/** 以游標（screen 座標）為中心縮放：游標下方的 world 點縮放前後保持不動；zoom 會被夾在 [MIN_ZOOM, MAX_ZOOM]。 */
export function zoomAt(vp: Viewport, cx: number, cy: number, factor: number): Viewport {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(cx) || !Number.isFinite(cy)) return vp;
  const zoom = clampZoom(vp.zoom * factor);
  const w = screenToWorld(vp, cx, cy);
  return { zoom, panX: cx - w.x * zoom, panY: cy - w.y * zoom };
}

/** wheel 事件的 deltaY 正規化為像素（deltaMode: 0=pixel, 1=line, 2=page）。 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  return deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * Math.max(pageHeight, 1) : deltaY;
}

export function wheelFactor(deltaPx: number): number {
  return Math.exp(-Math.max(-2000, Math.min(2000, deltaPx)) * WHEEL_ZOOM_RATE);
}

export function boundsOf(points: ArrayLike<{ x: number; y: number; r: number }>): Bounds | null {
  let b: Bounds | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (!b) b = { minX: p.x - p.r, minY: p.y - p.r, maxX: p.x + p.r, maxY: p.y + p.r };
    else {
      b.minX = Math.min(b.minX, p.x - p.r);
      b.minY = Math.min(b.minY, p.y - p.r);
      b.maxX = Math.max(b.maxX, p.x + p.r);
      b.maxY = Math.max(b.maxY, p.y + p.r);
    }
  }
  return b;
}

/**
 * 適合畫面：讓 bounds 完整落在 size 內（含 padding），並置中。
 * bounds 為 null（沒有節點）或 size 為 0 時回傳置中的 identity，不產生 NaN。
 */
export function fitToView(bounds: Bounds | null, size: Size, padding = FIT_PADDING_PX): Viewport {
  if (!bounds || size.w <= 0 || size.h <= 0) return identityViewport(size);
  const bw = Math.max(bounds.maxX - bounds.minX, 1);
  const bh = Math.max(bounds.maxY - bounds.minY, 1);
  const availW = Math.max(size.w - padding * 2, 1);
  const availH = Math.max(size.h - padding * 2, 1);
  const zoom = Math.min(FIT_MAX_ZOOM, clampZoom(Math.min(availW / bw, availH / bh)));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { zoom, panX: size.w / 2 - cx * zoom, panY: size.h / 2 - cy * zoom };
}
