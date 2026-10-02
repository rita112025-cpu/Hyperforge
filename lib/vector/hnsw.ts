/**
 * 自建 HNSW（Hierarchical Navigable Small World），純 TS、無 DOM。
 * 距離 = 1 - cosine；向量在插入時正規化，故為 1 - dot。
 */

export interface HNSWOptions {
  dim: number;
  /** 每層最大鄰居數（第 0 層為 2*M） */
  M?: number;
  efConstruction?: number;
  efSearch?: number;
  /** 決定層級抽樣的亂數種子，使結果可重現 */
  seed?: number;
}

export interface SearchHit {
  id: string;
  /** cosine 相似度，範圍 [-1, 1] */
  score: number;
}

interface Node {
  id: string;
  vec: Float32Array;
  level: number;
  /** links[l] = 第 l 層鄰居的節點索引 */
  links: number[][];
}

export interface HNSWSnapshot {
  version: 1;
  dim: number;
  M: number;
  efConstruction: number;
  efSearch: number;
  seed: number;
  rngState: number;
  entry: number;
  nodes: { id: string; vec: number[]; level: number; links: number[][] }[];
}

/** 小型二元堆。cmp(a,b)<0 表示 a 在堆頂。 */
class Heap<T> {
  private a: T[] = [];
  constructor(private cmp: (x: T, y: T) => number) {}
  get size() {
    return this.a.length;
  }
  peek(): T | undefined {
    return this.a[0];
  }
  push(v: T) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

type Cand = { i: number; d: number };

export class HNSW {
  readonly dim: number;
  private M: number;
  private efConstruction: number;
  private efSearch: number;
  private seed: number;
  private rng: number;
  private mL: number;
  private nodes: Node[] = [];
  private byId = new Map<string, number>();
  private entry = -1;

  constructor(opts: HNSWOptions) {
    if (!Number.isInteger(opts.dim) || opts.dim <= 0) throw new RangeError("dim must be a positive integer");
    this.dim = opts.dim;
    this.M = opts.M ?? 16;
    if (this.M < 2) throw new RangeError("M must be >= 2");
    this.efConstruction = opts.efConstruction ?? 100;
    this.efSearch = opts.efSearch ?? 50;
    this.seed = opts.seed ?? 42;
    this.rng = this.seed >>> 0;
    this.mL = 1 / Math.log(this.M);
  }

  get size(): number {
    return this.nodes.length;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** mulberry32：可重現的亂數，狀態可序列化 */
  private rand(): number {
    this.rng = (this.rng + 0x6d2b79f5) >>> 0;
    let t = this.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private dist(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return 1 - s;
  }

  private normalize(v: ArrayLike<number>): Float32Array {
    if (v.length !== this.dim) throw new RangeError(`expected dim ${this.dim}, got ${v.length}`);
    const out = new Float32Array(this.dim);
    let n = 0;
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) throw new RangeError("vector contains non-finite value");
      n += v[i] * v[i];
    }
    n = Math.sqrt(n);
    if (n === 0) return out; // 零向量：與任何向量相似度為 0
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  }

  /** 在第 layer 層做 ef 搜尋，回傳依距離由近到遠排序的候選。 */
  private searchLayer(q: Float32Array, eps: Cand[], ef: number, layer: number): Cand[] {
    const visited = new Set<number>(eps.map((e) => e.i));
    const cand = new Heap<Cand>((x, y) => x.d - y.d); // 最近者在頂
    const best = new Heap<Cand>((x, y) => y.d - x.d); // 最遠者在頂
    for (const e of eps) {
      cand.push(e);
      best.push(e);
    }
    while (cand.size) {
      const c = cand.pop()!;
      if (best.size >= ef && c.d > best.peek()!.d) break;
      for (const nb of this.nodes[c.i].links[layer] ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const d = this.dist(q, this.nodes[nb].vec);
        if (best.size < ef || d < best.peek()!.d) {
          cand.push({ i: nb, d });
          best.push({ i: nb, d });
          if (best.size > ef) best.pop();
        }
      }
    }
    const out: Cand[] = [];
    while (best.size) out.push(best.pop()!);
    return out.reverse();
  }

  /** 啟發式鄰居選擇（HNSW 論文 Algorithm 4，不含 extendCandidates）。cands 需由近到遠。 */
  private selectNeighbors(cands: Cand[], m: number): Cand[] {
    const picked: Cand[] = [];
    for (const c of cands) {
      if (picked.length >= m) break;
      let ok = true;
      for (const p of picked) {
        if (this.dist(this.nodes[c.i].vec, this.nodes[p.i].vec) < c.d) {
          ok = false;
          break;
        }
      }
      if (ok) picked.push(c);
    }
    // 補滿：保留連通性
    for (const c of cands) {
      if (picked.length >= m) break;
      if (!picked.includes(c)) picked.push(c);
    }
    return picked;
  }

  add(id: string, vector: ArrayLike<number>): void {
    if (this.byId.has(id)) throw new Error(`duplicate id: ${id}`);
    const vec = this.normalize(vector);
    const level = Math.floor(-Math.log(1 - this.rand()) * this.mL);
    const idx = this.nodes.length;
    const node: Node = { id, vec, level, links: Array.from({ length: level + 1 }, () => []) };
    this.nodes.push(node);
    this.byId.set(id, idx);

    if (this.entry < 0) {
      this.entry = idx;
      return;
    }

    let eps: Cand[] = [{ i: this.entry, d: this.dist(vec, this.nodes[this.entry].vec) }];
    const topLevel = this.nodes[this.entry].level;
    for (let l = topLevel; l > level; l--) eps = [this.searchLayer(vec, eps, 1, l)[0]];

    for (let l = Math.min(level, topLevel); l >= 0; l--) {
      const found = this.searchLayer(vec, eps, this.efConstruction, l);
      const maxM = l === 0 ? this.M * 2 : this.M;
      const neighbors = this.selectNeighbors(found, this.M);
      node.links[l] = neighbors.map((n) => n.i);
      for (const n of neighbors) {
        const links = this.nodes[n.i].links[l];
        links.push(idx);
        if (links.length > maxM) {
          const nv = this.nodes[n.i].vec;
          const sorted = links.map((i) => ({ i, d: this.dist(nv, this.nodes[i].vec) })).sort((a, b) => a.d - b.d);
          this.nodes[n.i].links[l] = this.selectNeighbors(sorted, maxM).map((c) => c.i);
        }
      }
      eps = found;
    }
    if (level > topLevel) this.entry = idx;
  }

  search(query: ArrayLike<number>, k: number, ef?: number): SearchHit[] {
    if (!Number.isInteger(k) || k <= 0) throw new RangeError("k must be a positive integer");
    if (this.entry < 0) return [];
    const q = this.normalize(query);
    let eps: Cand[] = [{ i: this.entry, d: this.dist(q, this.nodes[this.entry].vec) }];
    for (let l = this.nodes[this.entry].level; l > 0; l--) eps = [this.searchLayer(q, eps, 1, l)[0]];
    const found = this.searchLayer(q, eps, Math.max(ef ?? this.efSearch, k), 0);
    return found.slice(0, k).map((c) => ({ id: this.nodes[c.i].id, score: 1 - c.d }));
  }

  toJSON(): HNSWSnapshot {
    return {
      version: 1,
      dim: this.dim,
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
      seed: this.seed,
      rngState: this.rng,
      entry: this.entry,
      nodes: this.nodes.map((n) => ({ id: n.id, vec: Array.from(n.vec), level: n.level, links: n.links })),
    };
  }

  static fromJSON(s: HNSWSnapshot): HNSW {
    if (s.version !== 1) throw new Error(`unsupported snapshot version: ${s.version}`);
    const h = new HNSW({ dim: s.dim, M: s.M, efConstruction: s.efConstruction, efSearch: s.efSearch, seed: s.seed });
    h.rng = s.rngState;
    h.entry = s.entry;
    h.nodes = s.nodes.map((n) => ({ id: n.id, vec: Float32Array.from(n.vec), level: n.level, links: n.links }));
    h.nodes.forEach((n, i) => h.byId.set(n.id, i));
    return h;
  }
}
