import { HyperforgeDB } from "./db";

let shared: HyperforgeDB | null = null;

/**
 * 全域唯一的 HyperforgeDB（Dexie 實例）。只在瀏覽器端事件 / effect 中呼叫。
 * 刻意不 import embedder / transformers：畫布讀取已持久化的文件文字時不需要、也不得初始化 embedder。
 */
export function getSharedDb(): HyperforgeDB {
  shared ??= new HyperforgeDB();
  return shared;
}
