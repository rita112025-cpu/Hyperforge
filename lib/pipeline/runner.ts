import { deconstruct, link, parse } from "./stages";
import type { VectorStore } from "../vector/index-store";
import type { IngestContext, IngestSource, StageId, StageState } from "./types";
import { STAGE_ORDER } from "./types";

export interface RunnerHooks {
  onStage: (id: StageId, patch: Partial<StageState>) => void;
  signal?: AbortSignal;
  /** 注入向量庫；未提供或 embedder 不可用時，LINK 只做關鍵字並標記 indexed=false */
  store?: VectorStore;
}

/** 本輪尚未接入實作的階段：標 skipped，進度條不動。 */
const SKIPPED: Record<string, string> = {
  RECOMBINE: "未接入（待 embedding / 圖譜輪次）",
  EVOLVE: "未接入",
  MANIFEST: "未接入（待畫布 / 輸出輪次）",
};

export function initialStages(): StageState[] {
  return STAGE_ORDER.map((id) => ({ id, status: id in SKIPPED ? "skipped" : "idle", progress: 0, note: SKIPPED[id] }));
}

export async function runPipeline(source: IngestSource, hooks: RunnerHooks): Promise<IngestContext> {
  const { signal } = hooks;
  const step = async <T,>(id: StageId, fn: (r: (p: number, note?: string) => void) => Promise<T>): Promise<T> => {
    let last = 0;
    hooks.onStage(id, { status: "running", progress: 0 });
    try {
      const out = await fn((p, note) => {
        const next = Number.isFinite(p) ? Math.max(last, Math.min(1, p)) : last; // 單調遞增、擋 NaN
        last = next;
        if (!signal?.aborted) hooks.onStage(id, { progress: next, ...(note !== undefined ? { note } : {}) });
      });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      hooks.onStage(id, { status: "done", progress: 1 });
      return out;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") hooks.onStage(id, { status: "cancelled" });
      else hooks.onStage(id, { status: "error", note: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  const { name, rawText } = await step("PARSE", (r) => parse(source, r, signal));
  const chunks = await step("DECONSTRUCT", (r) => deconstruct(rawText, r, signal));
  let docId: string | undefined;
  let indexed = false;
  const keywords = await step("LINK", async (r) => {
    const store = hooks.store;
    const canEmbed = store ? await store.isAvailable() : false;
    // 有向量化：關鍵字佔前 20%，向量化佔後 80%
    const kw = await link(chunks, (p) => r(canEmbed ? p * 0.2 : p), signal);
    if (!store || !canEmbed) {
      r(1, "向量化略過：模型未安裝（不使用假向量）");
      return kw;
    }
    const res = await store.ingest({ name, rawText, chunks }, (p) => r(0.2 + p * 0.8, `向量化 ${Math.round(p * 100)}%`), signal);
    docId = res.docId;
    indexed = true;
    if (res.duplicate) r(1, "內容已存在，未重複寫入");
    return kw;
  });
  return { name, rawText, chunks, keywords, docId, indexed };
}
