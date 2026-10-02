"use client";
import { HyperforgeDB } from "./db";
import type { Embedder } from "./embedder";
import { VectorStore } from "./index-store";
import { TransformersEmbedder } from "./transformers-embedder";

export interface RuntimeDeps {
  createDb: () => HyperforgeDB;
  createEmbedder: () => Embedder;
  isBrowser: () => boolean;
}

/**
 * 建立「取得全域 VectorStore」的函式：
 * - 成功的 store 以單一 promise 快取（並發只 init 一次）；
 * - 模型不可用或 init 失敗 → 回傳 null 並清掉快取，下次呼叫會重試（不會永久壞掉）。
 */
export function createStoreGetter(deps: RuntimeDeps): () => Promise<VectorStore | null> {
  let pending: Promise<VectorStore | null> | null = null;
  return () => {
    if (!deps.isBrowser()) return Promise.resolve(null);
    pending ??= (async () => {
      try {
        const store = new VectorStore(deps.createDb(), deps.createEmbedder());
        if (!(await store.isAvailable())) return null;
        await store.init();
        return store;
      } catch (e) {
        console.error("[hyperforge] VectorStore 初始化失敗，略過向量化：", e);
        return null;
      }
    })().then((s) => {
      if (!s) pending = null;
      return s;
    });
    return pending;
  };
}

export const getVectorStore = createStoreGetter({
  createDb: () => new HyperforgeDB(),
  createEmbedder: () => new TransformersEmbedder(),
  isBrowser: () => typeof window !== "undefined",
});
