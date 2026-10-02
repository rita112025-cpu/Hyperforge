import { ALCHEMY_BADGE } from "./alchemy";
import type { GraphController } from "./controller";
import type { GraphNode, NodeShape } from "./types";

/**
 * Canvas 繪製（只用 Canvas 2D API）。所有節點名稱一律以 fillText() 繪製，
 * 不經過 innerHTML / 任何 HTML 解析，因此使用者檔案裡的 `<img onerror=…>` 之類內容只會被畫成字面文字。
 * 座標全部在 screen 空間（CSS px）計算；由呼叫端先 setTransform 成 devicePixelRatio 縮放。
 */

/** 本檔實際用到的 CanvasRenderingContext2D 子集（讓測試可用記錄型 mock，不需要 DOM）。 */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "fill"
  | "stroke"
  | "fillRect"
  | "strokeRect"
  | "fillText"
  | "clearRect"
  | "setLineDash"
> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
};

export const COLORS = {
  background: "#09090b",
  concept: { fill: "#4c1d95", stroke: "#a78bfa" },
  person: { fill: "#78350f", stroke: "#fbbf24" },
  temp: { fill: "#134e4a", stroke: "#5eead4" },
  selected: "#ffffff",
  hover: "#22d3ee",
  edge: "167,139,250",
  alchemyEdge: "94,234,212",
  text: "#e4e4e7",
  textDim: "#a1a1aa",
  box: "#22d3ee",
} as const;

export const FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", monospace';
/** 標籤顯示寬度上限（單位：Latin = 1、CJK = 2） */
export const LABEL_MAX_UNITS = 22;
/** zoom 低於此值時，只顯示被選取 / hover 的節點標籤 */
export const LABEL_MIN_ZOOM = 0.45;

const isWide = (cp: number) => (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || cp >= 0x20000;

/** 標籤的粗估顯示寬度（單位數 × 每單位像素），用於防碰撞；不使用 measureText（每 frame 150 次太貴）。 */
export const LABEL_UNIT_PX = 6.7;
export const LABEL_HEIGHT_PX = 14;
export const LABEL_PAD_PX = 2;

export function labelUnits(label: string): number {
  let u = 0;
  for (const ch of label) u += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return u;
}

/** 以「顯示寬度單位」截斷標籤（CJK 字寬 = 2），超過時加 …。純函式，不使用 measureText。 */
export function truncateLabel(label: string, maxUnits = LABEL_MAX_UNITS): string {
  let units = 0;
  let out = "";
  for (const ch of label) {
    const w = isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (units + w > maxUnits) return `${out}…`;
    units += w;
    out += ch;
  }
  return out;
}

/** 在 (cx, cy) 為中心描出節點形狀的路徑；幾何與 hit.ts 的 pointInShape 一致。 */
export function shapePath(ctx: Pick<Ctx, "beginPath" | "closePath" | "moveTo" | "lineTo" | "arc">, shape: NodeShape, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (shape === "diamond") {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
  } else {
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k; // 頂點在左右、上下為平邊
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
}

function palette(n: GraphNode) {
  return n.kind === "person" ? COLORS.person : n.kind === "temp" ? COLORS.temp : COLORS.concept;
}

export interface DrawStats {
  nodes: number;
  edges: number;
  labels: number;
}

/** 繪製一個 frame。回傳實際繪製的數量（供測試與效能紀錄）。 */
export function drawGraph(ctx: Ctx, c: GraphController, cssWidth: number, cssHeight: number): DrawStats {
  const { nodes, edges, sim, viewport: vp, selection } = c;
  const sx = (i: number) => sim.x[i] * vp.zoom + vp.panX;
  const sy = (i: number) => sim.y[i] * vp.zoom + vp.panY;
  const hover = c.hoverIndex;

  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // ── 邊：co-occurrence 依權重分桶、同一桶一次 stroke；與選取/hover 節點相連的邊另外加亮 ──
  const buckets: number[][] = [[], [], [], []];
  const hot: number[] = [];
  const alchemy: number[] = [];
  edges.forEach((e, k) => {
    const active = selection.has(nodes[e.a].id) || selection.has(nodes[e.b].id) || e.a === hover || e.b === hover;
    if (e.kind === "alchemy") alchemy.push(k);
    else if (active) hot.push(k);
    else buckets[e.weight >= 5 ? 3 : e.weight >= 3 ? 2 : e.weight >= 2 ? 1 : 0].push(k);
  });
  const strokeEdges = (list: number[], style: string, width: number, dash: number[] = []) => {
    if (!list.length) return;
    ctx.beginPath();
    for (const k of list) {
      const e = edges[k];
      ctx.moveTo(sx(e.a), sy(e.a));
      ctx.lineTo(sx(e.b), sy(e.b));
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  strokeEdges(buckets[0], `rgba(${COLORS.edge},0.16)`, 1);
  strokeEdges(buckets[1], `rgba(${COLORS.edge},0.26)`, 1.4);
  strokeEdges(buckets[2], `rgba(${COLORS.edge},0.36)`, 1.9);
  strokeEdges(buckets[3], `rgba(${COLORS.edge},0.5)`, 2.4);
  strokeEdges(alchemy, `rgba(${COLORS.alchemyEdge},0.6)`, 1.5, [5, 4]);
  strokeEdges(hot, "rgba(34,211,238,0.85)", 2);

  // ── 節點 ──
  const showAllLabels = vp.zoom >= LABEL_MIN_ZOOM;
  let labels = 0;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const x = sx(i);
    const y = sy(i);
    const r = n.r * vp.zoom;
    if (x + r < -40 || y + r < -40 || x - r > cssWidth + 40 || y - r > cssHeight + 40) continue; // 視窗外
    const pal = palette(n);
    shapePath(ctx, n.shape, x, y, r);
    ctx.fillStyle = pal.fill;
    ctx.fill();
    ctx.strokeStyle = pal.stroke;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(n.temporary ? [4, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    const isSel = selection.has(n.id);
    if (isSel || i === hover) {
      shapePath(ctx, n.shape, x, y, r + 4);
      ctx.strokeStyle = isSel ? COLORS.selected : COLORS.hover;
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.stroke();
    }
    if (n.temporary && r >= 10) {
      ctx.font = FONT;
      ctx.fillStyle = COLORS.text;
      ctx.fillText(ALCHEMY_BADGE, x, y); // 暫存標記
    }
  }

  // 標籤（在所有節點之後畫，避免被後面的節點蓋住）。
  // 防碰撞：依優先序貪婪放置——選取/hover → 暫存節點 → 其餘依分數（節點陣列本身就是分數排序）。
  // 與已放置標籤重疊者不畫（zoom 放大、節點散開後自然會出現）；選取/hover 的標籤永遠畫。
  ctx.font = FONT;
  const forced: number[] = [];
  const temps: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (selection.has(nodes[i].id) || i === hover) forced.push(i);
    else if (nodes[i].temporary) temps.push(i);
    else rest.push(i);
  }
  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const i of [...forced, ...temps, ...rest]) {
    const n = nodes[i];
    const isSel = selection.has(n.id);
    const force = isSel || i === hover;
    if (!(showAllLabels || force)) continue;
    const x = sx(i);
    const y = sy(i) + n.r * vp.zoom + 11;
    if (x < -80 || y < -20 || x > cssWidth + 80 || y > cssHeight + 20) continue;
    const text = truncateLabel(n.label);
    const half = (labelUnits(text) * LABEL_UNIT_PX) / 2 + LABEL_PAD_PX;
    const box = { x0: x - half, x1: x + half, y0: y - LABEL_HEIGHT_PX / 2 - 1, y1: y + LABEL_HEIGHT_PX / 2 + 1 };
    if (!force && placed.some((p) => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1)) continue;
    placed.push(box);
    ctx.fillStyle = force ? COLORS.text : COLORS.textDim;
    ctx.fillText(text, x, y);
    labels++;
    if (n.heuristic && force) {
      ctx.fillStyle = COLORS.person.stroke;
      ctx.fillText("heuristic", x, y + 13); // 人名為英文啟發式，非 NER / AI
    }
  }

  // ── 框選矩形 ──
  if (c.box) {
    const b = c.box;
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = COLORS.box;
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.box;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.setLineDash([]);
  }
  return { nodes: nodes.length, edges: edges.length, labels };
}
