import { describe, expect, it } from "vitest";
import { HNSW } from "../vector/hnsw";
import { generateBenchText, monitorMainThread, recallAtK, syntheticVectors } from "./forge-bench";

describe("generateBenchText", () => {
  it("長度剛好、同 seed 結果相同、不同 seed 不同", () => {
    const a = generateBenchText(200_000);
    expect(a).toHaveLength(200_000);
    expect(generateBenchText(200_000)).toBe(a);
    expect(generateBenchText(5_000, 2)).not.toBe(a.slice(0, 5_000));
  });
});

describe("syntheticVectors", () => {
  it("決定性、單位長度", () => {
    const [v] = syntheticVectors(1, 16);
    expect(syntheticVectors(1, 16)[0]).toEqual(v);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });
});

describe("recallAtK", () => {
  it("小資料集上 HNSW 的 recall@10 接近 1；空資料為 0", () => {
    const vecs = syntheticVectors(200, 16);
    const rows = vecs.map((vec, i) => ({ id: `v${i}`, vec }));
    const index = new HNSW({ dim: 16 });
    for (const r of rows) index.add(r.id, r.vec);
    expect(recallAtK(index, rows, 10, 20)).toBeGreaterThan(0.9);
    expect(recallAtK(index, [], 10, 20)).toBe(0);
  });
});

describe("monitorMainThread", () => {
  it("stop() 前最後一段同步阻塞（計時器尚未執行）也會被計入；重複 stop 回傳同一份報告", () => {
    const m = monitorMainThread(10);
    const until = performance.now() + 150;
    while (performance.now() < until) {
      /* 同步阻塞 150ms */
    }
    const report = m.stop();
    expect(report.maxBlockMs).toBeGreaterThanOrEqual(100);
    expect(m.stop()).toBe(report);
  });
});
