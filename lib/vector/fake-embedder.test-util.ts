import { tokenize } from "../pipeline/chunker";
import type { Embedder } from "./embedder";

/** 測試用：決定性的 hashed bag-of-tokens 向量。不是真的語意向量，禁止在產品路徑使用（lib/no-fake-in-product.test.ts 會檢查）。 */
export class FakeEmbedder implements Embedder {
  readonly id = "fake-hash-v1";
  constructor(
    readonly dim = 64,
    private available = true,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const tok of tokenize(t.toLowerCase())) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
        v[h % this.dim] += 1;
      }
      return v;
    });
  }
}
