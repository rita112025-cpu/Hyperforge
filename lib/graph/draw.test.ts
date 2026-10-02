import { describe, expect, it } from "vitest";
import { ALCHEMY_BADGE } from "./alchemy";
import { GraphController } from "./controller";
import { LABEL_HEIGHT_PX, LABEL_MAX_UNITS, LABEL_UNIT_PX, drawGraph, labelUnits, shapePath, truncateLabel, type Ctx } from "./draw";
import type { GraphEdge, GraphNode, NodeShape } from "./types";

/** 記錄所有 method 呼叫的 mock ctx；屬性可自由讀寫。 */
function recorder() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...args: unknown[]) => void calls.push({ fn: k, args });
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as Ctx;
  const texts = () => calls.filter((c) => c.fn === "fillText").map((c) => c.args[0] as string);
  return { ctx, calls, texts };
}

const node = (id: string, label: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  key: label,
  label,
  kind: "concept",
  shape: "circle" as NodeShape,
  heuristic: false,
  temporary: false,
  score: 1,
  freq: 2,
  docFreq: 1,
  chunkFreq: 1,
  x,
  y,
  r: 14,
  ...extra,
});

function setup(nodes: GraphNode[], edges: GraphEdge[] = []) {
  const c = new GraphController();
  c.setSize(800, 600);
  c.setGraph(nodes, edges);
  nodes.forEach((n, i) => {
    c.sim.x[i] = n.x;
    c.sim.y[i] = n.y;
  });
  c.viewport = { panX: 400, panY: 300, zoom: 1 };
  return c;
}

describe("truncateLabel", () => {
  it("Latin 以 1 單位、CJK 以 2 單位計；超過時加 …", () => {
    expect(truncateLabel("short")).toBe("short");
    expect(truncateLabel("x".repeat(LABEL_MAX_UNITS))).toBe("x".repeat(LABEL_MAX_UNITS));
    expect(truncateLabel("x".repeat(LABEL_MAX_UNITS + 1))).toBe(`${"x".repeat(LABEL_MAX_UNITS)}…`);
    expect(truncateLabel("電".repeat(11))).toBe("電".repeat(11)); // 22 單位
    expect(truncateLabel("電".repeat(12))).toBe(`${"電".repeat(11)}…`);
    expect(truncateLabel("")).toBe("");
  });

  it("不拆開 surrogate pair（以 code point 迭代）", () => {
    const out = truncateLabel("𠀀".repeat(20), 6);
    expect(out).toBe(`${"𠀀".repeat(3)}…`);
  });
});

describe("shapePath 幾何", () => {
  const path = (shape: NodeShape) => {
    const r = recorder();
    shapePath(r.ctx, shape, 100, 100, 10);
    return r.calls;
  };
  it("circle = 一個 arc；diamond = 4 個頂點；hexagon = 6 個頂點（頂點在左右）", () => {
    expect(path("circle").map((c) => c.fn)).toEqual(["beginPath", "arc"]);
    expect(path("diamond").map((c) => c.fn)).toEqual(["beginPath", "moveTo", "lineTo", "lineTo", "lineTo", "closePath"]);
    const hex = path("hexagon");
    expect(hex.filter((c) => c.fn === "moveTo" || c.fn === "lineTo")).toHaveLength(6);
    expect(hex[1].args).toEqual([110, 100]); // 第一個頂點在最右
  });
});

describe("drawGraph：所有文字經由 fillText 繪製", () => {
  it("hostile 標籤原樣以 fillText 繪出（不是 HTML）；canvas 沒有任何其他文字輸出途徑", () => {
    const evil = `<img src=x onerror=1>`;
    const c = setup([node("a", evil, -50, 0), node("b", "安全", 60, 0)]);
    const r = recorder();
    const stats = drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toContain(evil);
    expect(r.texts()).toContain("安全");
    expect(stats.labels).toBe(2);
    // mock 只允許 Canvas 2D 方法；任何 innerHTML 之類的存取都不存在於 Ctx 型別，這裡確認呼叫的全是繪圖方法
    const used = new Set(r.calls.map((x) => x.fn));
    for (const fn of used) expect(["beginPath", "closePath", "moveTo", "lineTo", "arc", "fill", "stroke", "fillRect", "strokeRect", "fillText", "setLineDash", "clearRect", "save", "restore"]).toContain(fn);
  });

  it("暫存節點畫出「暫存」標記；選取中的人名節點顯示 heuristic 標示", () => {
    const temp = node("temp:1", "A × B", 0, 0, { kind: "temp", shape: "hexagon", temporary: true, r: 18 });
    const person = node("person:ada", "Ada Lovelace", 120, 0, { kind: "person", shape: "diamond", heuristic: true });
    const c = setup([temp, person]);
    let r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toContain(ALCHEMY_BADGE);
    expect(r.texts()).not.toContain("heuristic"); // 未選取 / hover 時不顯示
    c.select(["person:ada"]);
    r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toContain("heuristic");
  });

  it("視窗外的節點不繪製", () => {
    const c = setup([node("a", "in", 0, 0), node("b", "out", 5000, 5000)]);
    const r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toContain("in");
    expect(r.texts()).not.toContain("out");
  });

  it("zoom 低於門檻時只顯示選取 / hover 的標籤", () => {
    const c = setup([node("a", "alpha", 0, 0), node("b", "bravo", 80, 0)]);
    c.viewport = { panX: 400, panY: 300, zoom: 0.3 };
    let r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toEqual([]);
    c.select(["b"]);
    r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toEqual(["bravo"]);
  });

  it("標籤防碰撞：重疊的標籤只畫優先者（分數高者）；選取 / hover 的標籤永遠畫", () => {
    // a、b、c 三個節點幾乎疊在一起（標籤必然重疊）；d 離得很遠
    const nodes = [node("a", "alphaaa", 0, 0), node("b", "bravooo", 8, 2), node("c", "charlie", -6, 3), node("d", "delta", 300, 200)];
    const c = setup(nodes);
    let r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toContain("alphaaa"); // 排序在前（分數高）者優先
    expect(r.texts()).toContain("delta"); // 不與任何人重疊
    expect(r.texts()).not.toContain("bravooo");
    expect(r.texts()).not.toContain("charlie");
    // 選取被蓋住的節點：它的標籤一定會畫，且排在最前面
    c.select(["c"]);
    r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.texts()).toContain("charlie");
    expect(r.texts()[0]).toBe("charlie");
    expect(r.texts()).not.toContain("alphaaa"); // 現在 alphaaa 與 charlie 的標籤重疊，被讓位
  });

  it("標籤防碰撞：150 個密集節點時只畫一部分標籤，且畫出的標籤兩兩不重疊", () => {
    const nodes = Array.from({ length: 150 }, (_, i) => node(`n${i}`, `node${String(i).padStart(3, "0")}x`, (i % 15) * 22 - 160, Math.floor(i / 15) * 22 - 100));
    const c = setup(nodes);
    const r = recorder();
    const stats = drawGraph(r.ctx, c, 800, 600);
    expect(stats.labels).toBeGreaterThan(5);
    expect(stats.labels).toBeLessThan(150);
    const boxes = r.calls
      .filter((x) => x.fn === "fillText")
      .map((x) => ({ x: x.args[1] as number, y: x.args[2] as number, w: labelUnits(x.args[0] as string) * LABEL_UNIT_PX }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
        const overlapY = Math.abs(a.y - b.y) < LABEL_HEIGHT_PX;
        expect(overlapX && overlapY, `labels ${i}/${j} overlap`).toBe(false);
      }
    }
  });

  it("邊以分桶批次繪製（150 個節點、600 條邊的 frame 只有少數 stroke 呼叫）", () => {
    const nodes = Array.from({ length: 150 }, (_, i) => node(`n${i}`, `n${i}`, (i % 15) * 40 - 280, Math.floor(i / 15) * 40 - 180));
    const edges: GraphEdge[] = Array.from({ length: 600 }, (_, k) => ({
      id: `e${k}`,
      a: `n${k % 150}`,
      b: `n${(k * 7 + 1) % 150}`,
      weight: 1 + (k % 6),
      kind: "co-occurrence" as const,
    })).filter((e) => e.a !== e.b);
    const c = setup(nodes, edges);
    const r = recorder();
    const stats = drawGraph(r.ctx, c, 800, 600);
    expect(stats.nodes).toBe(150);
    expect(stats.edges).toBeGreaterThan(590);
    const strokes = r.calls.filter((x) => x.fn === "stroke").length;
    expect(strokes).toBeLessThan(150 + 20); // 每個節點一次外框 + 少數邊桶
  });

  it("框選矩形與 alchemy 邊會被繪製", () => {
    const a = node("a", "a", -50, 0);
    const b = node("b", "b", 50, 0);
    const t = node("temp:x", "t", 0, 80, { kind: "temp", temporary: true, shape: "hexagon", parents: ["a", "b"] });
    const c = setup([a, b, t], [{ id: "x", a: "temp:x", b: "a", weight: 1, kind: "alchemy" }]);
    c.pointerDown(10, 10, { shift: true });
    c.pointerMove(300, 200);
    const r = recorder();
    drawGraph(r.ctx, c, 800, 600);
    expect(r.calls.some((x) => x.fn === "strokeRect")).toBe(true);
    expect(r.calls.some((x) => x.fn === "setLineDash" && Array.isArray(x.args[0]) && (x.args[0] as number[]).length > 0)).toBe(true);
  });
});
