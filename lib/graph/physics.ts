/**
 * 力導向 physics（純函式，不依賴 DOM / React；不引入任何 graph library）。
 *
 * 力：節點間排斥（O(n²)，n ≤ MAX_GRAPH_NODES + 暫存節點，約 150–170）、邊的彈簧、向中心的重力、速度阻尼。
 * 每個 tick 結尾做碰撞分離（positional correction），所以節點不會互相重疊。
 * 重合節點（距離 ≈ 0）以「由節點索引決定的固定角度」推開，不使用隨機數、不除以 0 → 結果決定性。
 * pinned 節點（拖曳中）不受力、不被碰撞推動，位置只由外部 setPosition 決定。
 *
 * 狀態以 Float64Array 儲存（struct-of-arrays），由呼叫端放在 ref 中；
 * 不得每個 animation frame 寫入 React state / Zustand。
 */

export interface PhysicsConfig {
  /** 排斥強度 R：F = R / (d² + softening) */
  repulsion: number;
  repulsionSoftening: number;
  springK: number;
  springLength: number;
  /** 邊權重對彈簧剛性的放大：k * (1 + springWeightGain * ln(weight)) */
  springWeightGain: number;
  /** 向原點的重力係數：F = -gravity * pos */
  gravity: number;
  /** 每 tick 速度保留比例 (0, 1) */
  damping: number;
  maxSpeed: number;
  collisionPadding: number;
  collisionIterations: number;
  /** 平均速度低於此值連續 sleepTicks 個 tick 後進入休眠（停止模擬與重繪，節省 CPU） */
  sleepSpeed: number;
  sleepTicks: number;
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  repulsion: 5200,
  repulsionSoftening: 400,
  springK: 0.018,
  springLength: 120,
  springWeightGain: 0.35,
  gravity: 0.0045,
  damping: 0.82,
  maxSpeed: 28,
  collisionPadding: 3,
  collisionIterations: 3,
  sleepSpeed: 0.02,
  sleepTicks: 45,
};

/** 固定時間步長：60 Hz。實際經過時間以 accumulator 換算成整數個 tick。 */
export const FIXED_DT_MS = 1000 / 60;
/** 單一 frame 最多補幾個 tick（避免分頁切回來後一次跑太多，造成 spiral of death） */
export const MAX_STEPS_PER_FRAME = 4;

const EPS = 1e-9;

export interface PhysicsState {
  count: number;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  radius: Float64Array;
  /** 1 = 釘住（拖曳中）：不受力、不被碰撞推動 */
  pinned: Uint8Array;
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeW: Float64Array;
  fx: Float64Array;
  fy: Float64Array;
  /** 本 tick 積分前的位置（用來把「碰撞修正後的實際位移」還原成速度） */
  ox: Float64Array;
  oy: Float64Array;
  quiet: number;
  asleep: boolean;
  accumulator: number;
  ticks: number;
}

export interface PhysicsNodeInit {
  x: number;
  y: number;
  r: number;
}
export interface PhysicsEdgeInit {
  a: number;
  b: number;
  weight: number;
}

export function createPhysics(nodes: PhysicsNodeInit[], edges: PhysicsEdgeInit[]): PhysicsState {
  const n = nodes.length;
  const valid = edges.filter((e) => e.a !== e.b && e.a >= 0 && e.b >= 0 && e.a < n && e.b < n);
  const s: PhysicsState = {
    count: n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    radius: new Float64Array(n),
    pinned: new Uint8Array(n),
    edgeA: Int32Array.from(valid, (e) => e.a),
    edgeB: Int32Array.from(valid, (e) => e.b),
    edgeW: Float64Array.from(valid, (e) => (Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1)),
    fx: new Float64Array(n),
    fy: new Float64Array(n),
    ox: new Float64Array(n),
    oy: new Float64Array(n),
    quiet: 0,
    asleep: false,
    accumulator: 0,
    ticks: 0,
  };
  nodes.forEach((p, i) => {
    s.x[i] = Number.isFinite(p.x) ? p.x : 0;
    s.y[i] = Number.isFinite(p.y) ? p.y : 0;
    s.radius[i] = Number.isFinite(p.r) && p.r > 0 ? p.r : 10;
  });
  return s;
}

/** 由索引對決定的固定方向（用於重合節點）。 */
export function pairAngle(i: number, j: number): number {
  let h = Math.imul(i + 1, 73856093) ^ Math.imul(j + 1, 19349663);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

export function wake(s: PhysicsState): void {
  s.asleep = false;
  s.quiet = 0;
}

export function pinNode(s: PhysicsState, i: number): void {
  s.pinned[i] = 1;
  s.vx[i] = 0;
  s.vy[i] = 0;
  wake(s);
}

export function releaseNode(s: PhysicsState, i: number): void {
  s.pinned[i] = 0;
  s.vx[i] = 0;
  s.vy[i] = 0;
  wake(s);
}

/** 外部（拖曳）直接設定位置；非有限值被忽略。 */
export function setPosition(s: PhysicsState, i: number, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  s.x[i] = x;
  s.y[i] = y;
  s.vx[i] = 0;
  s.vy[i] = 0;
  wake(s);
}

/** 推進一個 tick。回傳每個非 pinned 節點的平均 v²（v = 本 tick 的實際位移）。 */
export function stepPhysics(s: PhysicsState, cfg: PhysicsConfig = DEFAULT_PHYSICS): number {
  const { count: n, x, y, vx, vy, fx, fy, pinned, radius } = s;
  fx.fill(0);
  fy.fill(0);

  // 排斥
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = x[i] - x[j];
      let dy = y[i] - y[j];
      let d2 = dx * dx + dy * dy;
      if (d2 < EPS) {
        const a = pairAngle(i, j);
        dx = Math.cos(a) * 1e-3;
        dy = Math.sin(a) * 1e-3;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const f = cfg.repulsion / (d2 + cfg.repulsionSoftening);
      const ux = dx / d;
      const uy = dy / d;
      fx[i] += ux * f;
      fy[i] += uy * f;
      fx[j] -= ux * f;
      fy[j] -= uy * f;
    }
  }

  // 彈簧
  for (let e = 0; e < s.edgeA.length; e++) {
    const a = s.edgeA[e];
    const b = s.edgeB[e];
    let dx = x[b] - x[a];
    let dy = y[b] - y[a];
    let d2 = dx * dx + dy * dy;
    if (d2 < EPS) {
      const ang = pairAngle(a, b);
      dx = Math.cos(ang) * 1e-3;
      dy = Math.sin(ang) * 1e-3;
      d2 = dx * dx + dy * dy;
    }
    const d = Math.sqrt(d2);
    const k = cfg.springK * (1 + cfg.springWeightGain * Math.log(s.edgeW[e]));
    const f = k * (d - cfg.springLength);
    const ux = dx / d;
    const uy = dy / d;
    fx[a] += ux * f;
    fy[a] += uy * f;
    fx[b] -= ux * f;
    fy[b] -= uy * f;
  }

  // 重力 + 積分
  const { ox, oy } = s;
  for (let i = 0; i < n; i++) {
    ox[i] = x[i];
    oy[i] = y[i];
    if (pinned[i]) {
      vx[i] = 0;
      vy[i] = 0;
      continue;
    }
    fx[i] -= cfg.gravity * x[i];
    fy[i] -= cfg.gravity * y[i];
    let nvx = (vx[i] + fx[i]) * cfg.damping;
    let nvy = (vy[i] + fy[i]) * cfg.damping;
    const sp = Math.hypot(nvx, nvy);
    if (sp > cfg.maxSpeed) {
      nvx = (nvx / sp) * cfg.maxSpeed;
      nvy = (nvy / sp) * cfg.maxSpeed;
    }
    vx[i] = nvx;
    vy[i] = nvy;
    x[i] += nvx;
    y[i] += nvy;
  }

  // 每個 tick 結尾做碰撞分離
  for (let it = 0; it < cfg.collisionIterations; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (pinned[i] && pinned[j]) continue;
        const min = radius[i] + radius[j] + cfg.collisionPadding;
        let dx = x[j] - x[i];
        let dy = y[j] - y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < EPS) {
          const a = pairAngle(i, j);
          dx = Math.cos(a);
          dy = Math.sin(a);
          d = 0;
        } else {
          dx /= d;
          dy /= d;
        }
        const push = min - d;
        const wi = pinned[i] ? 0 : pinned[j] ? 1 : 0.5;
        const wj = pinned[j] ? 0 : pinned[i] ? 1 : 0.5;
        x[i] -= dx * push * wi;
        y[i] -= dy * push * wi;
        x[j] += dx * push * wj;
        y[j] += dy * push * wj;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // 速度改為「碰撞修正後的實際位移」：節點被壓在接觸面上時不會累積假速度；動能與休眠也據此判斷
  let energy = 0;
  let free = 0;
  for (let i = 0; i < n; i++) {
    if (pinned[i]) continue;
    vx[i] = x[i] - ox[i];
    vy[i] = y[i] - oy[i];
    energy += vx[i] * vx[i] + vy[i] * vy[i];
    free++;
  }

  // 防爆：非有限值（理論上不會發生）以索引決定的位置重置，並清掉速度
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i]) || !Number.isFinite(vx[i]) || !Number.isFinite(vy[i])) {
      const a = pairAngle(i, i + 1);
      x[i] = Math.cos(a) * 50;
      y[i] = Math.sin(a) * 50;
      vx[i] = 0;
      vy[i] = 0;
    }
  }

  s.ticks += 1;
  const mean = free > 0 ? energy / free : 0;
  if (mean < cfg.sleepSpeed * cfg.sleepSpeed) {
    s.quiet += 1;
    if (s.quiet >= cfg.sleepTicks) s.asleep = true;
  } else {
    s.quiet = 0;
  }
  return mean;
}

/**
 * 固定時間步長推進：把真實經過時間換算成整數個 tick。休眠時不做任何事。
 * 回傳本次實際執行的 tick 數。
 */
export function advance(s: PhysicsState, elapsedMs: number, cfg: PhysicsConfig = DEFAULT_PHYSICS): number {
  if (s.asleep) {
    s.accumulator = 0;
    return 0;
  }
  const dt = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  s.accumulator += Math.min(dt, FIXED_DT_MS * MAX_STEPS_PER_FRAME * 4);
  let steps = 0;
  while (s.accumulator >= FIXED_DT_MS && steps < MAX_STEPS_PER_FRAME && !s.asleep) {
    stepPhysics(s, cfg);
    s.accumulator -= FIXED_DT_MS;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) s.accumulator = 0; // 追不上就丟棄餘量
  return steps;
}

/** 同步跑 n 個 tick（用於首次出現時預先收斂、以及測試）。 */
export function settle(s: PhysicsState, ticks: number, cfg: PhysicsConfig = DEFAULT_PHYSICS): void {
  for (let i = 0; i < ticks && !s.asleep; i++) stepPhysics(s, cfg);
}
