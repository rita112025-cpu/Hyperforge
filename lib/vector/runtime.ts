"use client";
import { HyperforgeDB } from "./db";
import type { Embedder } from "./embedder";
import { ModelMismatchError, VectorStore } from "./index-store";
import { getSharedDb } from "./shared-db";
import { TransformersEmbedder } from "./transformers-embedder";

export interface RuntimeDeps {
  createDb: () => HyperforgeDB;
  createEmbedder: () => Embedder;
  isBrowser: () => boolean;
}

/** store 為 null 時，reason 說明為何略過向量化（會顯示在 job 的 note） */
export interface StoreResult {
  store: VectorStore | null;
  reason?: string;
}

export const RESET_HINT = "清除瀏覽器 IndexedDB 資料庫 'hyperforge' 後重試（DevTools → Application → IndexedDB → Delete database）";

/**
 * 建立「取得全域 VectorStore」的函式：
 * - 成功的 store 以單一 promise 快取（並發只 init 一次）；
 * - 模型不可用或 init 失敗 → 回傳 {store:null, reason} 並清掉快取，下次呼叫會重試（不會永久壞掉）。
 */
export function createStoreGetter(deps: RuntimeDeps): () => Promise<StoreResult> {
  let pending: Promise<StoreResult> | null = null;
  return () => {
    if (!deps.isBrowser()) return Promise.resolve({ store: null, reason: "非瀏覽器環境" });
    pending ??= (async (): Promise<StoreResult> => {
      try {
        const store = new VectorStore(deps.createDb(), deps.createEmbedder());
        if (!(await store.isAvailable())) {
          return { store: null, reason: "模型未安裝（請執行 npm run fetch-model）" };
        }
        await store.init();
        return { store };
      } catch (e) {
        console.error("[hyperforge] VectorStore 初始化失敗，略過向量化：", e);
        if (e instanceof ModelMismatchError) {
          return { store: null, reason: `向量庫為舊模型建立，需重建。${RESET_HINT}` };
        }
        return { store: null, reason: `向量庫初始化失敗：${e instanceof Error ? e.message : String(e)}` };
      }
    })().then((r) => {
      if (!r.store) pending = null;
      return r;
    });
    return pending;
  };
}

export const getVectorStore = createStoreGetter({
  createDb: () => getSharedDb(), // 與畫布共用同一個 Dexie 實例
  createEmbedder: () => new TransformersEmbedder(),
  isBrowser: () => typeof window !== "undefined",
});

/** 開發用：刪除整個向量庫（換模型或資料損毀時用）。呼叫後請重新載入頁面。 */
export async function resetVectorDb(name = "hyperforge"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("資料庫被其他分頁佔用，請關閉其他分頁後重試"));
  });
}
