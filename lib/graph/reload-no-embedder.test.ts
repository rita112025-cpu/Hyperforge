import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

// 下毒：reload 路徑（IndexedDB → graph）只要 import 到任何 embedder / 向量執行期模組就會在載入時丟錯。
vi.mock("../vector/transformers-embedder", () => {
  throw new Error("reload 路徑不得 import transformers-embedder");
});
vi.mock("../vector/runtime", () => {
  throw new Error("reload 路徑不得 import runtime（getVectorStore）");
});
vi.mock("../vector/index-store", () => {
  throw new Error("reload 路徑不得 import index-store（VectorStore）");
});
vi.mock("@xenova/transformers", () => {
  throw new Error("reload 路徑不得 import @xenova/transformers");
});

import { chunkText } from "../pipeline/chunker";
import { HyperforgeDB } from "../vector/db";
import { buildGraph } from "./build";
import { loadCorpus, saveDocument } from "./corpus";

describe("reload：IndexedDB → graph 不需要 embedder（相關模組被下毒仍可運作）", () => {
  it("下毒機制本身有效：直接 import 被下毒的模組會丟錯（否則下面的綠燈沒有意義）", async () => {
    await expect(import("../vector/runtime")).rejects.toThrow(/error when mocking a module|不得 import/);
    await expect(import("../vector/transformers-embedder")).rejects.toThrow(/error when mocking a module|不得 import/);
    await expect(import("../vector/index-store")).rejects.toThrow(/error when mocking a module|不得 import/);
  });

  it("寫入文字、重新開啟資料庫、載入並建圖，全程不 import 任何 embedder 模組", async () => {
    const name = `reload-poison-${Date.now()}`;
    const text = "電纜槽淨距不足，需要調整弱電橋架位置。弱電橋架與電纜槽之間必須保留足夠間距。";

    const writer = new HyperforgeDB(name);
    await saveDocument(writer, { name: "a.md", rawText: text, chunks: chunkText(text) });
    writer.close();

    // 模擬重新載入頁面：全新的 Dexie 實例開啟同一個資料庫
    const reader = new HyperforgeDB(name);
    const graph = buildGraph(await loadCorpus(reader));
    expect(graph.nodes.map((n) => n.key).sort()).toEqual(["弱電", "橋架", "電纜槽"].sort());
    expect(await reader.vectors.count()).toBe(0); // 沒有任何向量，畫布照樣有內容
    reader.close();
    await reader.delete();
  });
});
