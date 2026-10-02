import { hitNodeAt, nodesInRect, normalizeRect, type HitSet, type Rect } from "./hit";
import { advance, createPhysics, pinNode, releaseNode, setPosition, settle, wake, type PhysicsState } from "./physics";
import { hashUnit } from "./seed";
import type { EdgeKind, GraphEdge, GraphNode } from "./types";
import {
  boundsOf,
  fitToView,
  identityViewport,
  normalizeWheelDelta,
  panBy,
  screenToWorld,
  wheelFactor,
  zoomAt,
  type Size,
  type Viewport,
} from "./viewport";

/**
 * Canvas 互動 + 模擬的控制器（與 DOM / React 無關，座標一律是 canvas 的 CSS px）。
 * 位置、速度、viewport、hover、box 全部存在這個物件（由 React 放在 ref），
 * 不會每個 frame 寫入 React state / Zustand；只有 selection 變動時才透過 callback 通知 React。
 */

/** 指標移動超過這個距離才算「拖曳」，否則視為點擊 */
export const CLICK_SLOP_PX = 4;
/** 命中容許誤差（螢幕像素） */
export const HIT_SLOP_PX = 3;
/** 圖第一次出現時預先收斂的 tick 數（同步執行，避免使用者看到一團重疊的節點爆開） */
export const PRESETTLE_TICKS = 150;

export interface SelectionChange {
  ids: string[];
  focusId: string | null;
}

export interface ControllerEdge {
  a: number;
  b: number;
  weight: number;
  kind: EdgeKind;
}

type Mode =
  | { kind: "idle" }
  | { kind: "pan"; lastX: number; lastY: number; startX: number; startY: number; moved: boolean }
  | { kind: "node"; index: number; id: string; startX: number; startY: number; offX: number; offY: number; moved: boolean; shift: boolean }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; additive: boolean };

export interface PointerOptions {
  shift?: boolean;
  /** 0 = 主鍵。其他按鍵（右鍵 / 中鍵）不啟動互動 */
  button?: number;
}

export class GraphController {
  nodes: GraphNode[] = [];
  edges: ControllerEdge[] = [];
  sim: PhysicsState = createPhysics([], []);
  viewport: Viewport = identityViewport();
  size: Size = { w: 0, h: 0 };
  selection = new Set<string>();
  focusId: string | null = null;
  hoverIndex = -1;
  /** 框選矩形（screen 座標，已正規化）；沒有框選時為 null */
  box: Rect | null = null;
  /** true = 空白處拖曳為框選（否則為平移；Shift+拖曳永遠是框選） */
  boxMode = false;
  onSelectionChange: ((c: SelectionChange) => void) | null = null;
  /** 由 API（非指標事件）造成需要重繪時呼叫，讓休眠中的 frame loop 被喚醒 */
  onInvalidate: (() => void) | null = null;

  private mode: Mode = { kind: "idle" };
  private hit: HitSet = { count: 0, x: [], y: [], r: [], shape: [] };
  private index = new Map<string, number>();
  private dirty = true;
  private fitPending = false;

  // ───────────── graph ─────────────

  /**
   * 載入（或更新）圖。已存在的節點沿用目前位置（以 id 對應），所以新增文件不會讓整張圖跳位；
   * 新節點使用 seeded 初始位置；暫存節點出現在其來源節點的重心附近。
   */
  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    const prev = new Map<string, { x: number; y: number }>();
    this.nodes.forEach((n, i) => prev.set(n.id, { x: this.sim.x[i], y: this.sim.y[i] }));
    const first = this.nodes.length === 0 && nodes.length > 0;

    const init = nodes.map((n) => {
      const p = prev.get(n.id);
      if (p) return { x: p.x, y: p.y, r: n.r };
      const anchors = (n.parents ?? []).flatMap((id) => {
        const q = prev.get(id);
        return q ? [q] : [];
      });
      if (anchors.length) {
        const cx = anchors.reduce((s, q) => s + q.x, 0) / anchors.length;
        const cy = anchors.reduce((s, q) => s + q.y, 0) / anchors.length;
        return { x: cx + (hashUnit(n.id, 3) - 0.5) * 40, y: cy + (hashUnit(n.id, 4) - 0.5) * 40, r: n.r };
      }
      return { x: n.x, y: n.y, r: n.r };
    });

    const dragged = this.mode.kind === "node" ? this.mode.id : null;
    const draggedPos = dragged !== null && this.mode.kind === "node" ? { x: this.sim.x[this.mode.index], y: this.sim.y[this.mode.index] } : null;

    this.nodes = nodes;
    this.index = new Map(nodes.map((n, i) => [n.id, i]));
    this.edges = edges.flatMap((e) => {
      const a = this.index.get(e.a);
      const b = this.index.get(e.b);
      return a === undefined || b === undefined ? [] : [{ a, b, weight: e.weight, kind: e.kind }];
    });
    this.sim = createPhysics(init, this.edges);
    this.hit = { count: nodes.length, x: this.sim.x, y: this.sim.y, r: this.sim.radius, shape: nodes.map((n) => n.shape) };

    // 進行中的拖曳：節點仍存在就維持 pinned，否則取消拖曳
    if (dragged !== null && this.mode.kind === "node") {
      const ni = this.index.get(dragged);
      if (ni === undefined) this.mode = { kind: "idle" };
      else {
        this.mode = { ...this.mode, index: ni };
        pinNode(this.sim, ni);
        if (draggedPos) setPosition(this.sim, ni, draggedPos.x, draggedPos.y);
      }
    }
    this.hoverIndex = -1;
    this.pruneSelection();
    wake(this.sim);
    if (first) {
      settle(this.sim, PRESETTLE_TICKS);
      wake(this.sim); // 預先收斂後仍讓畫面繼續微調到真正休眠
      this.fitPending = true;
      this.tryFit();
    }
    this.invalidate();
  }

  setSize(w: number, h: number): void {
    if (!(w > 0) || !(h > 0) || (w === this.size.w && h === this.size.h)) return;
    this.size = { w, h };
    this.tryFit();
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
    this.onInvalidate?.();
  }

  private tryFit(): void {
    if (this.fitPending && this.size.w > 0 && this.size.h > 0) {
      this.fit();
      this.fitPending = false;
    }
  }

  /** 適合畫面 */
  fit(): void {
    const pts = this.nodes.map((n, i) => ({ x: this.sim.x[i], y: this.sim.y[i], r: n.r + 18 })); // +18：留位給標籤
    this.viewport = fitToView(boundsOf(pts), this.size);
    this.invalidate();
  }

  indexOfId(id: string): number {
    return this.index.get(id) ?? -1;
  }

  // ───────────── frame ─────────────

  /** 以固定時間步長推進模擬。回傳是否仍需要繼續跑 frame。 */
  tick(elapsedMs: number): boolean {
    if (advance(this.sim, elapsedMs) > 0) this.dirty = true;
    return this.needsFrame();
  }

  /** 還需要畫 frame 嗎？（模擬醒著，或有尚未繪製的變更） */
  needsFrame(): boolean {
    return !this.sim.asleep || this.dirty;
  }

  /** 取走 dirty 旗標（繪製後呼叫）。 */
  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  markDirty(): void {
    this.invalidate();
  }

  // ───────────── selection ─────────────

  get hoverId(): string | null {
    return this.hoverIndex >= 0 ? this.nodes[this.hoverIndex].id : null;
  }

  select(ids: string[], focusId: string | null = ids.at(-1) ?? null): void {
    const next = ids.filter((id) => this.index.has(id));
    const same = next.length === this.selection.size && next.every((id) => this.selection.has(id));
    this.focusId = focusId && this.index.has(focusId) ? focusId : (next.at(-1) ?? null);
    if (same) return;
    this.selection = new Set(next);
    this.invalidate();
    this.onSelectionChange?.({ ids: [...this.selection], focusId: this.focusId });
  }

  clearSelection(): void {
    this.select([], null);
  }

  private pruneSelection(): void {
    const keep = [...this.selection].filter((id) => this.index.has(id));
    if (keep.length !== this.selection.size) this.select(keep, this.focusId);
  }

  // ───────────── pointer / wheel ─────────────

  private hitAt(sx: number, sy: number): number {
    const w = screenToWorld(this.viewport, sx, sy);
    return hitNodeAt(this.hit, w.x, w.y, HIT_SLOP_PX / this.viewport.zoom);
  }

  pointerDown(x: number, y: number, o: PointerOptions = {}): void {
    if (o.button !== undefined && o.button !== 0) return;
    if (this.mode.kind !== "idle") this.cancelInteraction(); // 前一次的 pointerup 遺失
    const i = this.hitAt(x, y);
    if (i >= 0) {
      const w = screenToWorld(this.viewport, x, y);
      this.mode = {
        kind: "node",
        index: i,
        id: this.nodes[i].id,
        startX: x,
        startY: y,
        offX: this.sim.x[i] - w.x,
        offY: this.sim.y[i] - w.y,
        moved: false,
        shift: !!o.shift,
      };
      pinNode(this.sim, i); // mousedown → pin
    } else if (o.shift || this.boxMode) {
      this.mode = { kind: "box", x0: x, y0: y, x1: x, y1: y, additive: !!o.shift };
      this.box = normalizeRect(x, y, x, y);
    } else {
      this.mode = { kind: "pan", lastX: x, lastY: y, startX: x, startY: y, moved: false };
    }
    this.dirty = true;
  }

  pointerMove(x: number, y: number): void {
    const m = this.mode;
    switch (m.kind) {
      case "pan": {
        this.viewport = panBy(this.viewport, x - m.lastX, y - m.lastY);
        m.lastX = x;
        m.lastY = y;
        if (!m.moved && Math.hypot(x - m.startX, y - m.startY) > CLICK_SLOP_PX) m.moved = true;
        this.dirty = true;
        break;
      }
      case "node": {
        if (!m.moved && Math.hypot(x - m.startX, y - m.startY) > CLICK_SLOP_PX) m.moved = true;
        if (m.moved) {
          const w = screenToWorld(this.viewport, x, y);
          setPosition(this.sim, m.index, w.x + m.offX, w.y + m.offY); // move（仍為 pinned，physics 不會把它拉走）
          this.dirty = true;
        }
        break;
      }
      case "box": {
        m.x1 = x;
        m.y1 = y;
        this.box = normalizeRect(m.x0, m.y0, x, y);
        this.dirty = true;
        break;
      }
      case "idle": {
        const i = this.hitAt(x, y);
        if (i !== this.hoverIndex) {
          this.hoverIndex = i;
          this.dirty = true;
        }
      }
    }
  }

  pointerUp(x: number, y: number): void {
    const m = this.mode;
    this.mode = { kind: "idle" };
    switch (m.kind) {
      case "node": {
        releaseNode(this.sim, m.index); // mouseup → release
        if (!m.moved) {
          // 點擊：選取（Shift = 切換加入/移除）
          if (m.shift) {
            const next = new Set(this.selection);
            if (next.has(m.id)) next.delete(m.id);
            else next.add(m.id);
            this.select([...next], next.has(m.id) ? m.id : ([...next].at(-1) ?? null));
          } else {
            this.select([m.id], m.id);
          }
        }
        break;
      }
      case "box": {
        this.box = null;
        const px = normalizeRect(m.x0, m.y0, x, y);
        if (px.x1 - px.x0 <= CLICK_SLOP_PX && px.y1 - px.y0 <= CLICK_SLOP_PX) {
          if (!m.additive) this.clearSelection(); // 沒拖出面積 = 點擊空白
        } else {
          const a = screenToWorld(this.viewport, px.x0, px.y0);
          const b = screenToWorld(this.viewport, px.x1, px.y1);
          const picked = nodesInRect(this.hit, normalizeRect(a.x, a.y, b.x, b.y)).map((i) => this.nodes[i].id);
          this.select(m.additive ? [...new Set([...this.selection, ...picked])] : picked);
        }
        break;
      }
      case "pan":
        if (!m.moved) this.clearSelection(); // 點擊空白
        break;
      case "idle":
        break;
    }
    this.dirty = true;
  }

  /** 指標離開 / 被系統取消：放開 pin、結束框選與平移，不改變選取。 */
  cancelInteraction(): void {
    const m = this.mode;
    if (m.kind === "node") releaseNode(this.sim, m.index);
    this.mode = { kind: "idle" };
    this.box = null;
    this.dirty = true;
  }

  pointerLeave(): void {
    if (this.mode.kind === "idle" && this.hoverIndex !== -1) {
      this.hoverIndex = -1;
      this.dirty = true;
    }
  }

  /** wheel：以游標為中心縮放（呼叫端須在 `{ passive: false }` 的原生 listener 內 preventDefault）。 */
  wheel(x: number, y: number, deltaY: number, deltaMode = 0): void {
    this.viewport = zoomAt(this.viewport, x, y, wheelFactor(normalizeWheelDelta(deltaY, deltaMode, this.size.h)));
    this.dirty = true;
  }

  /** 右鍵：若點在未選取的節點上，先把它單選；回傳目前選取的 id。 */
  contextMenuAt(x: number, y: number): { hitId: string | null; selected: string[] } {
    const i = this.hitAt(x, y);
    const hitId = i >= 0 ? this.nodes[i].id : null;
    if (hitId && !this.selection.has(hitId)) this.select([hitId], hitId);
    return { hitId, selected: [...this.selection] };
  }

  /** 目前應該顯示的游標 */
  cursor(): string {
    switch (this.mode.kind) {
      case "pan":
        return "grabbing";
      case "node":
        return this.mode.moved ? "grabbing" : "pointer";
      case "box":
        return "crosshair";
      default:
        return this.hoverIndex >= 0 ? "pointer" : this.boxMode ? "crosshair" : "grab";
    }
  }
}
