import { describe, expect, it } from "vitest";
import baseline from "./zh-semantic.json";
import { MULTILINGUAL } from "../model-spec";

/** 只驗證 baseline 檔本身與程式設定一致、且語意條件成立；真模型數值只能在瀏覽器重新取得 */
describe("zh-semantic baseline", () => {
  const ids = Object.keys(baseline.sentences) as Array<keyof typeof baseline.matrix>;
  const m = baseline.matrix;

  it("記錄的模型與程式目前的設定一致（換模型時必須重新取得 baseline）", () => {
    expect(baseline.model.id).toBe(MULTILINGUAL.id);
    expect(baseline.model.revision).toBe(MULTILINGUAL.revision);
    expect(baseline.model.maxSeq).toBe(MULTILINGUAL.maxSeq);
  });

  it("矩陣對稱、對角線為 1", () => {
    for (const a of ids) {
      expect(m[a][a]).toBe(1);
      for (const b of ids) expect(Math.abs(m[a][b] - m[b][a])).toBeLessThan(1e-9);
    }
  });

  it("同主題 > 異主題：每個句子最相近的都是同主題句，且領先 ≥ 0.3", () => {
    const topic = (k: string) => baseline.sentences[k as keyof typeof baseline.sentences].topic;
    for (const a of ids) {
      const same = ids.filter((b) => b !== a && topic(b) === topic(a));
      const diff = ids.filter((b) => topic(b) !== topic(a));
      if (!same.length) continue;
      const minSame = Math.min(...same.map((b) => m[a][b]));
      const maxDiff = Math.max(...diff.map((b) => m[a][b]));
      expect(minSame - maxDiff).toBeGreaterThanOrEqual(0.3);
    }
  });
});
