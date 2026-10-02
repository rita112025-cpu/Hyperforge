import { describe, expect, it } from "vitest";
import { buildGraph } from "./build";
import { CLICK_SLOP_PX, GraphController, PRESETTLE_TICKS, type SelectionChange } from "./controller";
import { seededPosition } from "./seed";
import type { GraphDocument, GraphEdge, GraphNode, NodeShape } from "./types";
import { screenToWorld, worldToScreen } from "./viewport";

const mkNode = (id: string, x: number, y: number, r = 20, shape: NodeShape = "circle", extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  key: id,
  label: id,
  kind: "concept",
  shape,
  heuristic: false,
  temporary: false,
  score: 1,
  freq: 2,
  docFreq: 1,
  chunkFreq: 1,
  x,
  y,
  r,
  ...extra,
});

/** 800×600、identity 以畫面中心為原點（screen = world + (400,300)），節點直接放在指定的 world 位置。 */
function setup(specs: Array<[string, number, number, number?, NodeShape?]>, edges: GraphEdge[] = []) {
  const c = new GraphController();
  c.setSize(800, 600);
  c.setGraph(specs.map(([id, x, y, r, s]) => mkNode(id, x, y, r, s)), edges);
  specs.forEach(([, x, y], i) => {
    c.sim.x[i] = x;
    c.sim.y[i] = y;
    c.sim.vx[i] = 0;
    c.sim.vy[i] = 0;
  });
  c.viewport = { panX: 400, panY: 300, zoom: 1 };
  c.sim.asleep = true;
  const changes: SelectionChange[] = [];
  c.onSelectionChange = (s) => changes.push(s);
  const screen = (id: string) => worldToScreen(c.viewport, c.sim.x[c.indexOfId(id)], c.sim.y[c.indexOfId(id)]);
  return { c, changes, screen };
}

const SPECS: Array<[string, number, number, number?, NodeShape?]> = [
  ["a", -200, -100],
  ["b", 0, 0],
  ["c", 200, 100],
  ["d", 200, -150],
];

describe("setGraph", () => {
  it("第一次出現：預先收斂（PRESETTLE_TICKS）並適合畫面，所有節點都在畫面內", () => {
    const docText = Array.from({ length: 40 }, (_, i) => `term${String(i).padStart(2, "0")}x term${String(i).padStart(2, "0")}x filler${i % 5}pad`).join(". ");
    const doc: GraphDocument = { id: "d", name: "d", rawText: docText, chunks: [{ index: 0, start: 0, end: docText.length }] };
    const g = buildGraph([doc]);
    expect(g.nodes.length).toBeGreaterThan(20);
    const c = new GraphController();
    c.setSize(900, 600);
    c.setGraph(g.nodes, g.edges);
    expect(c.sim.ticks).toBe(PRESETTLE_TICKS);
    for (let i = 0; i < c.nodes.length; i++) {
      const p = worldToScreen(c.viewport, c.sim.x[i], c.sim.y[i]);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(900);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(600);
    }
  });

  it("尺寸稍後才known：第一次 setSize 時才 fit", () => {
    const c = new GraphController();
    c.setGraph([mkNode("a", 0, 0), mkNode("b", 300, 0)], []);
    expect(c.viewport.zoom).toBe(1); // 尚無尺寸：維持 identity
    c.setSize(800, 600);
    expect(c.viewport.zoom).toBeGreaterThan(1); // 兩個節點很小 → 放大到 fit
    expect(Object.values(c.viewport).every(Number.isFinite)).toBe(true);
  });

  it("重建圖時沿用既有節點目前位置（以 id 對應），新節點使用 seeded 位置", () => {
    const { c } = setup(SPECS);
    c.sim.x[0] = 123;
    c.sim.y[0] = -77;
    const nodes = [mkNode("a", -200, -100), mkNode("b", 0, 0), mkNode("new", 5, 5)];
    c.setGraph(nodes, []);
    expect([c.sim.x[c.indexOfId("a")], c.sim.y[c.indexOfId("a")]]).toEqual([123, -77]);
    expect([c.sim.x[c.indexOfId("new")], c.sim.y[c.indexOfId("new")]]).toEqual([5, 5]);
    const seeded = seededPosition("concept:zzz");
    c.setGraph([...nodes, mkNode("z", seeded.x, seeded.y)], []);
    expect([c.sim.x[c.indexOfId("z")], c.sim.y[c.indexOfId("z")]]).toEqual([seeded.x, seeded.y]);
  });

  it("暫存節點出現在來源節點的重心附近，而不是它們的 seeded 位置", () => {
    const { c } = setup(SPECS);
    const temp = mkNode("temp:x", 9999, 9999, 16, "hexagon", { kind: "temp", temporary: true, parents: ["a", "c"] });
    c.setGraph([...c.nodes, temp], []);
    const t = c.indexOfId("temp:x");
    expect(Math.abs(c.sim.x[t] - 0)).toBeLessThan(25); // a、c 的 x 重心 = 0
    expect(Math.abs(c.sim.y[t] - 0)).toBeLessThan(25);
  });

  it("選取中的節點消失時被移出選取，並通知", () => {
    const { c, changes } = setup(SPECS);
    c.select(["a", "b"]);
    c.setGraph(c.nodes.filter((n) => n.id !== "a"), []);
    expect([...c.selection]).toEqual(["b"]);
    expect(changes.at(-1)).toEqual({ ids: ["b"], focusId: "b" });
  });
});

describe("pan（空白處拖曳）", () => {
  it("拖曳空白處平移 viewport；平移後不改變選取", () => {
    const { c, changes } = setup(SPECS);
    c.select(["b"]);
    changes.length = 0;
    c.pointerDown(100, 500);
    c.pointerMove(130, 480);
    c.pointerMove(160, 450);
    c.pointerUp(160, 450);
    expect(c.viewport).toEqual({ panX: 460, panY: 250, zoom: 1 });
    expect(changes).toEqual([]);
    expect([...c.selection]).toEqual(["b"]);
  });

  it("點擊空白（沒有移動超過門檻）清除選取", () => {
    const { c, changes } = setup(SPECS);
    c.select(["b", "c"]);
    changes.length = 0;
    c.pointerDown(100, 500);
    c.pointerMove(100 + CLICK_SLOP_PX - 1, 500);
    c.pointerUp(100, 500);
    expect(c.selection.size).toBe(0);
    expect(changes).toEqual([{ ids: [], focusId: null }]);
    expect(c.viewport.panX).toBe(400 + CLICK_SLOP_PX - 1); // 小幅移動仍然平移，只是不算「拖曳」
  });

  it("非主鍵（右鍵 / 中鍵）不啟動互動", () => {
    const { c } = setup(SPECS);
    c.pointerDown(100, 500, { button: 2 });
    c.pointerMove(300, 500);
    c.pointerUp(300, 500);
    expect(c.viewport.panX).toBe(400);
  });
});

describe("wheel zoom（以游標為中心）", () => {
  it("游標下方的 world 點在縮放前後位置不變", () => {
    const { c } = setup(SPECS);
    c.viewport = { panX: 410, panY: 250, zoom: 1.3 };
    const before = screenToWorld(c.viewport, 237, 411);
    c.wheel(237, 411, -240); // 向上滾 = 放大
    expect(c.viewport.zoom).toBeGreaterThan(1.3);
    const after = worldToScreen(c.viewport, before.x, before.y);
    expect(after.x).toBeCloseTo(237, 6);
    expect(after.y).toBeCloseTo(411, 6);
    c.wheel(237, 411, 240);
    expect(c.viewport.zoom).toBeCloseTo(1.3, 6); // 反向滾動還原
  });

  it("deltaMode=1（行）與 deltaMode=0（像素）一致換算", () => {
    const a = setup(SPECS).c;
    const b = setup(SPECS).c;
    a.wheel(300, 300, 3, 1);
    b.wheel(300, 300, 48, 0);
    expect(a.viewport).toEqual(b.viewport);
  });
});

describe("拖曳節點（mousedown → pin → move → mouseup）", () => {
  it("按下節點即 pin；移動後節點跟隨指標（保留抓取偏移）；放開後釋放 pin", () => {
    const { c, screen } = setup(SPECS);
    const b = c.indexOfId("b");
    const p = screen("b"); // (400, 300)
    c.pointerDown(p.x + 5, p.y + 5); // 抓在節點右下偏移處
    expect(c.sim.pinned[b]).toBe(1);
    c.pointerMove(p.x + 105, p.y + 55);
    expect([c.sim.x[b], c.sim.y[b]]).toEqual([100, 50]); // 位移 (100, 50)，偏移保留
    c.pointerUp(p.x + 105, p.y + 55);
    expect(c.sim.pinned[b]).toBe(0);
  });

  it("拖曳中 physics 不會把節點拉走（即使其他節點、重力、排斥都在作用）", () => {
    const edges: GraphEdge[] = [
      { id: "a--b", a: "a", b: "b", weight: 5, kind: "co-occurrence" },
      { id: "b--c", a: "b", b: "c", weight: 5, kind: "co-occurrence" },
    ];
    const { c, screen } = setup(SPECS, edges);
    const b = c.indexOfId("b");
    const p = screen("b");
    c.pointerDown(p.x, p.y);
    c.pointerMove(p.x + 50, p.y + 20);
    const held: [number, number] = [c.sim.x[b], c.sim.y[b]];
    for (let i = 0; i < 120; i++) c.tick(1000 / 60);
    expect([c.sim.x[b], c.sim.y[b]]).toEqual(held);
    c.pointerUp(p.x + 50, p.y + 20);
    for (let i = 0; i < 120; i++) c.tick(1000 / 60);
    expect([c.sim.x[b], c.sim.y[b]]).not.toEqual(held); // 放開後才受 physics 影響
  });

  it("拖曳不會改變選取；只在位移超過門檻後才開始移動（點擊不推動節點）", () => {
    const { c, screen, changes } = setup(SPECS);
    const b = c.indexOfId("b");
    const p = screen("b");
    c.pointerDown(p.x, p.y);
    c.pointerMove(p.x + 2, p.y + 1); // 未超過門檻
    expect([c.sim.x[b], c.sim.y[b]]).toEqual([0, 0]);
    c.pointerMove(p.x + 60, p.y);
    c.pointerUp(p.x + 60, p.y);
    expect(changes).toEqual([]);
  });

  it("拖曳時 pan 不會同時發生；viewport 不變", () => {
    const { c, screen } = setup(SPECS);
    const p = screen("b");
    c.pointerDown(p.x, p.y);
    c.pointerMove(p.x + 80, p.y + 80);
    c.pointerUp(p.x + 80, p.y + 80);
    expect(c.viewport).toEqual({ panX: 400, panY: 300, zoom: 1 });
  });

  it("pointerCancel 會釋放 pin，不留下卡住的節點", () => {
    const { c, screen } = setup(SPECS);
    const p = screen("b");
    c.pointerDown(p.x, p.y);
    c.pointerMove(p.x + 30, p.y);
    c.cancelInteraction();
    expect(c.sim.pinned[c.indexOfId("b")]).toBe(0);
    c.pointerUp(p.x, p.y); // 之後遲到的 pointerup 不應出錯或改變選取
    expect(c.selection.size).toBe(0);
  });

  it("前一次 pointerup 遺失時，新的 pointerdown 會先結束舊互動（不會留下兩個 pinned 節點）", () => {
    const { c, screen } = setup(SPECS);
    const pb = screen("b");
    c.pointerDown(pb.x, pb.y);
    const pc = screen("c");
    c.pointerDown(pc.x, pc.y);
    expect(c.sim.pinned[c.indexOfId("b")]).toBe(0);
    expect(c.sim.pinned[c.indexOfId("c")]).toBe(1);
  });
});

describe("點擊選取", () => {
  it("點擊節點選取；點另一個節點改為單選；focus 為最後點擊者", () => {
    const { c, screen, changes } = setup(SPECS);
    const pa = screen("a");
    c.pointerDown(pa.x, pa.y);
    c.pointerUp(pa.x, pa.y);
    expect(changes.at(-1)).toEqual({ ids: ["a"], focusId: "a" });
    const pc = screen("c");
    c.pointerDown(pc.x, pc.y);
    c.pointerUp(pc.x, pc.y);
    expect(changes.at(-1)).toEqual({ ids: ["c"], focusId: "c" });
  });

  it("Shift+點擊：切換加入 / 移除多選", () => {
    const { c, screen, changes } = setup(SPECS);
    for (const id of ["a", "b", "c"]) {
      const p = screen(id);
      c.pointerDown(p.x, p.y, { shift: true });
      c.pointerUp(p.x, p.y);
    }
    expect(changes.at(-1)).toEqual({ ids: ["a", "b", "c"], focusId: "c" });
    const pb = screen("b");
    c.pointerDown(pb.x, pb.y, { shift: true });
    c.pointerUp(pb.x, pb.y);
    expect(changes.at(-1)!.ids).toEqual(["a", "c"]);
  });

  it("命中使用形狀：點在菱形外接圓內但菱形外，不算點到該節點", () => {
    const { c, screen, changes } = setup([["p", 0, 0, 30, "diamond"]]);
    const p = screen("p");
    c.pointerDown(p.x + 20, p.y + 20); // 距中心 28.3 < r=30（在外接圓內），但 |dx|+|dy|=40 > r+slop → 在菱形外；若形狀是圓就會命中
    c.pointerUp(p.x + 20, p.y + 20);
    expect(changes).toEqual([]);
  });
});

describe("box selection（空白處拖框）", () => {
  it("Shift+拖曳：正向框選", () => {
    const { c, changes } = setup(SPECS);
    c.pointerDown(100, 100, { shift: true }); // world (-300,-200)
    c.pointerMove(500, 400);
    expect(c.box).toEqual({ x0: 100, y0: 100, x1: 500, y1: 400 });
    c.pointerUp(500, 400);
    expect(c.box).toBeNull();
    expect(changes.at(-1)!.ids.sort()).toEqual(["a", "b"]); // a(-200,-100) b(0,0)；c(200,100) 的 screen 在 (600,400) 之外
  });

  it("任意方向：四個拖曳方向選到相同的節點", () => {
    const corners: Array<[number, number, number, number]> = [
      [100, 100, 700, 500], // 左上 → 右下
      [700, 500, 100, 100], // 右下 → 左上
      [700, 100, 100, 500], // 右上 → 左下
      [100, 500, 700, 100], // 左下 → 右上
    ];
    const results = corners.map(([x0, y0, x1, y1]) => {
      const { c, changes } = setup(SPECS);
      c.pointerDown(x0, y0, { shift: true });
      c.pointerMove(x1, y1);
      c.pointerUp(x1, y1);
      return changes.at(-1)!.ids.sort();
    });
    for (const r of results) expect(r).toEqual(["a", "b", "c", "d"]);
  });

  it("沒有 Shift 的空白拖曳是平移，不是框選；開啟框選模式後空白拖曳才是框選", () => {
    const { c } = setup(SPECS);
    c.pointerDown(100, 100);
    c.pointerMove(500, 400);
    expect(c.box).toBeNull();
    c.pointerUp(500, 400);

    const m = setup(SPECS);
    m.c.boxMode = true;
    m.c.pointerDown(100, 100);
    m.c.pointerMove(500, 400);
    expect(m.c.box).not.toBeNull();
    m.c.pointerUp(500, 400);
    expect(m.changes.at(-1)!.ids.sort()).toEqual(["a", "b"]);
    expect(m.c.viewport.panX).toBe(400);
  });

  it("起點在節點上時是拖曳節點，不是框選（即使在框選模式）", () => {
    const { c, screen } = setup(SPECS);
    c.boxMode = true;
    const p = screen("b");
    c.pointerDown(p.x, p.y);
    c.pointerMove(p.x + 50, p.y + 50);
    expect(c.box).toBeNull();
    c.pointerUp(p.x + 50, p.y + 50);
  });

  it("Shift 框選為加選；沒有 Shift（框選模式）為取代", () => {
    const { c } = setup(SPECS);
    c.select(["d"]);
    c.pointerDown(100, 100, { shift: true });
    c.pointerMove(500, 400);
    c.pointerUp(500, 400);
    expect([...c.selection].sort()).toEqual(["a", "b", "d"]);

    const r = setup(SPECS);
    r.c.boxMode = true;
    r.c.select(["d"]);
    r.c.pointerDown(100, 100);
    r.c.pointerMove(500, 400);
    r.c.pointerUp(500, 400);
    expect([...r.c.selection].sort()).toEqual(["a", "b"]);
  });

  it("沒有拖出面積的框選視為點擊空白：清除選取（Shift 時保留）", () => {
    const { c } = setup(SPECS);
    c.select(["a"]);
    c.pointerDown(50, 550, { shift: true });
    c.pointerUp(50, 550);
    expect(c.selection.size).toBe(1);
    const m = setup(SPECS);
    m.c.boxMode = true;
    m.c.select(["a"]);
    m.c.pointerDown(50, 550);
    m.c.pointerUp(50, 550);
    expect(m.c.selection.size).toBe(0);
  });

  it("框選使用目前的 viewport（縮放 / 平移後仍正確）", () => {
    const { c } = setup(SPECS);
    c.viewport = { panX: 100, panY: 100, zoom: 0.5 }; // a 在 screen (0,50)，c 在 (200,150)
    c.pointerDown(150, 100, { shift: true });
    c.pointerMove(260, 200);
    c.pointerUp(260, 200);
    expect(c.selection.has("c")).toBe(true);
    expect(c.selection.has("a")).toBe(false);
  });
});

describe("右鍵選單目標、hover、游標", () => {
  it("右鍵在未選取的節點上：先單選該節點；在已多選的節點上：保留多選", () => {
    const { c, screen } = setup(SPECS);
    const pa = screen("a");
    expect(c.contextMenuAt(pa.x, pa.y)).toEqual({ hitId: "a", selected: ["a"] });
    c.select(["a", "b", "c"]);
    const pb = screen("b");
    expect(c.contextMenuAt(pb.x, pb.y)).toEqual({ hitId: "b", selected: ["a", "b", "c"] });
    expect(c.contextMenuAt(10, 10)).toEqual({ hitId: null, selected: ["a", "b", "c"] });
  });

  it("hover 更新 hoverId 與游標；離開後清除", () => {
    const { c, screen } = setup(SPECS);
    expect(c.cursor()).toBe("grab");
    const p = screen("c");
    c.pointerMove(p.x, p.y);
    expect(c.hoverId).toBe("c");
    expect(c.cursor()).toBe("pointer");
    c.pointerLeave();
    expect(c.hoverId).toBeNull();
    c.boxMode = true;
    expect(c.cursor()).toBe("crosshair");
  });
});

describe("fit", () => {
  it("fit() 讓所有節點落在畫面內", () => {
    const { c } = setup([
      ["a", -2000, -900],
      ["b", 1800, 1200],
    ]);
    c.fit();
    for (const id of ["a", "b"]) {
      const i = c.indexOfId(id);
      const p = worldToScreen(c.viewport, c.sim.x[i], c.sim.y[i]);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(800);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(600);
    }
  });

  it("沒有節點時 fit 不產生 NaN", () => {
    const c = new GraphController();
    c.setSize(800, 600);
    c.fit();
    expect(Object.values(c.viewport).every(Number.isFinite)).toBe(true);
  });
});
