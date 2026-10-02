import { describe, expect, it } from "vitest";
import { HNSW } from "./hnsw";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randVec = (r: () => number, dim: number) => Array.from({ length: dim }, () => r() * 2 - 1);

function cosine(a: number[], b: number[]) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("HNSW", () => {
  it("空索引搜尋回傳 []", () => expect(new HNSW({ dim: 3 }).search([1, 0, 0], 5)).toEqual([]));

  it("單點：回傳該點，score≈1", () => {
    const h = new HNSW({ dim: 3 });
    h.add("a", [1, 2, 3]);
    const [hit] = h.search([2, 4, 6], 3);
    expect(hit.id).toBe("a");
    expect(hit.score).toBeCloseTo(1, 5);
  });

  it("k 大於 n：只回傳 n 筆，且由相似到不相似排序", () => {
    const h = new HNSW({ dim: 2 });
    h.add("x", [1, 0]);
    h.add("y", [0, 1]);
    h.add("z", [1, 1]);
    const hits = h.search([1, 0.1], 10);
    expect(hits.map((x) => x.id)).toEqual(["x", "z", "y"]);
  });

  it("重複 id 丟錯；維度不符丟錯；非有限值丟錯；k<=0 丟錯", () => {
    const h = new HNSW({ dim: 2 });
    h.add("a", [1, 0]);
    expect(() => h.add("a", [0, 1])).toThrow();
    expect(() => h.add("b", [1, 2, 3])).toThrow();
    expect(() => h.add("c", [NaN, 1])).toThrow();
    expect(() => h.search([1, 0], 0)).toThrow();
  });

  it("重複向量不會壞掉", () => {
    const h = new HNSW({ dim: 2 });
    for (let i = 0; i < 20; i++) h.add(`d${i}`, [1, 1]);
    expect(h.search([1, 1], 5)).toHaveLength(5);
  });

  it("零向量可插入且不產生 NaN", () => {
    const h = new HNSW({ dim: 2 });
    h.add("z", [0, 0]);
    h.add("a", [1, 0]);
    expect(h.search([1, 0], 2).every((x) => Number.isFinite(x.score))).toBe(true);
  });

  it("recall@10 對暴力搜尋 >= 0.9（500 點、dim 32）", () => {
    const r = rng(7);
    const dim = 32;
    const data = Array.from({ length: 500 }, () => randVec(r, dim));
    const h = new HNSW({ dim, M: 16, efConstruction: 100, efSearch: 64 });
    data.forEach((v, i) => h.add(`n${i}`, v));
    let hit = 0, total = 0;
    for (let q = 0; q < 30; q++) {
      const qv = randVec(r, dim);
      const truth = data
        .map((v, i) => ({ id: `n${i}`, s: cosine(qv, v) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 10)
        .map((x) => x.id);
      const got = new Set(h.search(qv, 10).map((x) => x.id));
      truth.forEach((id) => got.has(id) && hit++);
      total += 10;
    }
    expect(hit / total).toBeGreaterThanOrEqual(0.9);
  });

  it("相同 seed 與插入順序 → 結果可重現", () => {
    const build = () => {
      const r = rng(3);
      const h = new HNSW({ dim: 8, seed: 5 });
      for (let i = 0; i < 100; i++) h.add(`n${i}`, randVec(r, 8));
      return h;
    };
    const q = randVec(rng(99), 8);
    expect(build().search(q, 5)).toEqual(build().search(q, 5));
  });

  it("序列化往返：toJSON → JSON → fromJSON 後搜尋結果相同", () => {
    const r = rng(11);
    const h = new HNSW({ dim: 8 });
    for (let i = 0; i < 80; i++) h.add(`n${i}`, randVec(r, 8));
    const copy = HNSW.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
    const q = randVec(r, 8);
    expect(copy.size).toBe(80);
    expect(copy.search(q, 5)).toEqual(h.search(q, 5));
    copy.add("extra", randVec(r, 8)); // 還原後仍可繼續插入
    expect(copy.size).toBe(81);
  });
});
