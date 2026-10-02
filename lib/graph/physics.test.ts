import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHYSICS,
  FIXED_DT_MS,
  MAX_STEPS_PER_FRAME,
  advance,
  createPhysics,
  pairAngle,
  pinNode,
  releaseNode,
  setPosition,
  settle,
  stepPhysics,
  wake,
  type PhysicsState,
} from "./physics";
import { seededPosition } from "./seed";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** 決定性的測試圖：n 個節點、m 條邊（半徑 9–22，與 builder 的節點半徑範圍一致）。 */
function randomGraph(n: number, m: number, seed = 42, coincident = false) {
  const rnd = lcg(seed);
  const nodes = Array.from({ length: n }, (_, i) => {
    const p = coincident ? { x: 0, y: 0 } : seededPosition(`concept:n${i}`);
    return { x: p.x, y: p.y, r: 9 + rnd() * 13 };
  });
  const edges = Array.from({ length: m }, () => ({ a: Math.floor(rnd() * n), b: Math.floor(rnd() * n), weight: 1 + Math.floor(rnd() * 5) }));
  return { nodes, edges };
}

function runUntilAsleep(s: PhysicsState, maxTicks = 5000): number {
  let t = 0;
  while (!s.asleep && t < maxTicks) {
    stepPhysics(s);
    t++;
  }
  return t;
}

function overlapCount(s: PhysicsState, tolerance = 0.5): number {
  let c = 0;
  for (let i = 0; i < s.count; i++) {
    for (let j = i + 1; j < s.count; j++) {
      if (Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]) - s.radius[i] - s.radius[j] < -tolerance) c++;
    }
  }
  return c;
}

const allFinite = (s: PhysicsState) => [...s.x, ...s.y, ...s.vx, ...s.vy].every(Number.isFinite);
const maxRadius = (s: PhysicsState) => Math.max(0, ...Array.from({ length: s.count }, (_, i) => Math.hypot(s.x[i], s.y[i])));

describe("physics：150 節點", () => {
  it("150 節點 / 600 邊：收斂休眠、不重疊、不爆炸、無 NaN", () => {
    const { nodes, edges } = randomGraph(150, 600);
    const s = createPhysics(nodes, edges);
    const ticks = runUntilAsleep(s);
    expect(s.asleep).toBe(true);
    expect(ticks).toBeLessThan(5000);
    expect(allFinite(s)).toBe(true);
    expect(overlapCount(s)).toBe(0);
    expect(maxRadius(s)).toBeLessThan(2000);
  });

  it("150 節點 / 150 邊（稀疏）：同樣收斂且不重疊", () => {
    const { nodes, edges } = randomGraph(150, 150, 7);
    const s = createPhysics(nodes, edges);
    runUntilAsleep(s);
    expect(s.asleep).toBe(true);
    expect(overlapCount(s)).toBe(0);
    expect(allFinite(s)).toBe(true);
  });

  it("150 個節點全部重合在原點：不除以 0、無 NaN，最終互相分離", () => {
    const { nodes } = randomGraph(150, 0, 1, true);
    const s = createPhysics(nodes, []);
    stepPhysics(s); // 第一個 tick 就不得產生 NaN
    expect(allFinite(s)).toBe(true);
    runUntilAsleep(s);
    expect(allFinite(s)).toBe(true);
    expect(overlapCount(s)).toBe(0);
  });

  it("seeded 決定性：相同初始條件跑相同 tick 數，位置逐位元相同", () => {
    const a = createPhysics(randomGraph(150, 400).nodes, randomGraph(150, 400).edges);
    const b = createPhysics(randomGraph(150, 400).nodes, randomGraph(150, 400).edges);
    settle(a, 300);
    settle(b, 300);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
  });

  it("Node 環境 benchmark（不是 browser FPS）：150 節點 / 600 邊平均每 tick < 5ms", () => {
    const { nodes, edges } = randomGraph(150, 600);
    const s = createPhysics(nodes, edges);
    stepPhysics(s); // warm-up
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) stepPhysics(s);
    const per = (performance.now() - t0) / N;
    expect(per).toBeLessThan(5);
  });
});

describe("physics：個別行為", () => {
  it("重合的兩節點：以索引決定的固定方向推開，結果決定性", () => {
    const mk = () => createPhysics([{ x: 5, y: 5, r: 10 }, { x: 5, y: 5, r: 10 }], []);
    const a = mk();
    const b = mk();
    stepPhysics(a);
    stepPhysics(b);
    expect(a.x[0]).not.toBe(a.x[1]);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(pairAngle(0, 1)).toBe(pairAngle(0, 1));
    expect(pairAngle(0, 1)).not.toBe(pairAngle(1, 2));
  });

  it("pinned 節點不受 physics 移動，即使被別的節點擠壓；且不會與它重疊", () => {
    const { nodes, edges } = randomGraph(60, 120, 3);
    const s = createPhysics(nodes, edges);
    pinNode(s, 0);
    const [px, py] = [s.x[0], s.y[0]];
    settle(s, 400);
    expect([s.x[0], s.y[0]]).toEqual([px, py]);
    expect([s.vx[0], s.vy[0]]).toEqual([0, 0]);
    for (let j = 1; j < s.count; j++) {
      expect(Math.hypot(s.x[j] - px, s.y[j] - py)).toBeGreaterThanOrEqual(s.radius[0] + s.radius[j] - 0.5);
    }
  });

  it("拖曳：setPosition 移動 pinned 節點，其他節點被推開；放開後 physics 恢復作用於它", () => {
    const s = createPhysics(
      [
        { x: 0, y: 0, r: 12 },
        { x: 200, y: 0, r: 12 },
      ],
      [],
    );
    pinNode(s, 0);
    setPosition(s, 0, 190, 0); // 拖到另一個節點旁邊
    settle(s, 50);
    expect(s.x[0]).toBe(190); // 沒被拉走
    expect(Math.abs(s.x[1] - 190)).toBeGreaterThanOrEqual(24); // 另一個被推開、不重疊
    releaseNode(s, 0);
    expect(s.pinned[0]).toBe(0);
    const before = s.x[0];
    settle(s, 100);
    expect(s.x[0]).not.toBe(before); // 放開後受力（重力/排斥）移動
  });

  it("setPosition 忽略非有限值", () => {
    const s = createPhysics([{ x: 1, y: 2, r: 10 }], []);
    setPosition(s, 0, NaN, 5);
    setPosition(s, 0, 3, Infinity);
    expect([s.x[0], s.y[0]]).toEqual([1, 2]);
  });

  it("重力：單一節點被拉向原點；彈簧：相連的兩節點距離收斂到 springLength 附近", () => {
    const one = createPhysics([{ x: 300, y: 0, r: 10 }], []);
    settle(one, 200);
    expect(Math.abs(one.x[0])).toBeLessThan(300);

    const two = createPhysics(
      [
        { x: -400, y: 0, r: 10 },
        { x: 400, y: 0, r: 10 },
      ],
      [{ a: 0, b: 1, weight: 1 }],
    );
    runUntilAsleep(two);
    const d = Math.hypot(two.x[0] - two.x[1], two.y[0] - two.y[1]);
    expect(d).toBeGreaterThan(DEFAULT_PHYSICS.springLength * 0.7);
    expect(d).toBeLessThan(DEFAULT_PHYSICS.springLength * 1.6);
  });

  it("輸入防呆：極端座標、NaN 座標、自環邊、越界邊都不產生 NaN", () => {
    const s = createPhysics(
      [
        { x: 1e9, y: -1e9, r: 10 },
        { x: NaN, y: Infinity, r: -5 },
        { x: 0, y: 0, r: 10 },
      ],
      [
        { a: 0, b: 0, weight: 1 },
        { a: 0, b: 99, weight: 1 },
        { a: -1, b: 1, weight: NaN },
        { a: 1, b: 2, weight: 0 },
      ],
    );
    expect(s.edgeA.length).toBe(1); // 只留下合法的邊
    settle(s, 300);
    expect(allFinite(s)).toBe(true);
  });

  it("空圖與單節點不拋錯", () => {
    expect(() => stepPhysics(createPhysics([], []))).not.toThrow();
    expect(() => settle(createPhysics([{ x: 0, y: 0, r: 10 }], []), 50)).not.toThrow();
  });
});

describe("physics：固定時間步長 advance()", () => {
  const mk = () => createPhysics(randomGraph(20, 30).nodes, randomGraph(20, 30).edges);

  it("每 FIXED_DT_MS 恰好一個 tick；不足一個 tick 的時間累積到下次", () => {
    const s = mk();
    expect(advance(s, FIXED_DT_MS * 0.5)).toBe(0);
    expect(advance(s, FIXED_DT_MS * 0.6)).toBe(1); // 累積 1.1 個 dt
    expect(advance(s, FIXED_DT_MS * 3)).toBe(3);
    expect(s.ticks).toBe(4);
  });

  it("單一 frame 最多補 MAX_STEPS_PER_FRAME 個 tick，餘量丟棄（不會越補越多）", () => {
    const s = mk();
    expect(advance(s, 10_000)).toBe(MAX_STEPS_PER_FRAME);
    expect(s.accumulator).toBe(0);
  });

  it("休眠時不執行任何 tick；wake 後恢復", () => {
    const s = mk();
    runUntilAsleep(s);
    const t = s.ticks;
    expect(advance(s, 1000)).toBe(0);
    expect(s.ticks).toBe(t);
    wake(s);
    expect(advance(s, FIXED_DT_MS * 2)).toBe(2);
  });

  it("非法的經過時間（NaN / 負數 / Infinity）不產生 tick、不污染 accumulator", () => {
    const s = mk();
    expect(advance(s, NaN)).toBe(0);
    expect(advance(s, -50)).toBe(0);
    expect(Number.isFinite(s.accumulator)).toBe(true);
    expect(advance(s, Infinity)).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME);
    expect(Number.isFinite(s.accumulator)).toBe(true);
  });
});
