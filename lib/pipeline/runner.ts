import { MAX_EMBED_CHUNKS, embedLimitNote, exceedsEmbedLimit } from "./limits";
import { deconstruct, link, parse, throwIfAborted, type Chunker } from "./stages";
import type { VectorStore } from "../vector/index-store";
import type { IngestContext, IngestSource, StageId, StageState, TextCommitPayload, TextCommitResult, TextStatus, VectorStatus } from "./types";
import { STAGE_ORDER } from "./types";

export interface StoreResolution {
  store: VectorStore | null;
  /** store 為 null 時的原因（顯示在 LINK 的 note） */
  reason?: string;
}

export interface RunnerHooks {
  onStage: (id: StageId, patch: Partial<StageState>) => void;
  signal?: AbortSignal;
  /**
   * TEXT COMMIT POINT。只在 PARSE 成功、DECONSTRUCT 完成、chunks 完整產生之後呼叫，且只呼叫一次；
   * 此時 embedding 尚未開始。呼叫前會最後一次檢查 AbortSignal（已取消就不呼叫、不留任何資料）；
   * 一旦進入就不再受取消影響、也不 rollback——取消只會停止後面的向量化。
   * 回傳 persist_failed 時 runner 不會做向量化（避免只有衍生資料、沒有原文）。
   * 沒有提供時，textStatus 維持 pending，向量化照常進行（store.ingest 自己寫 docs / chunks，僅供不關心 text commit 的呼叫端與測試）。
   */
  onTextReady?: (payload: TextCommitPayload) => Promise<TextCommitResult> | TextCommitResult;
  /** 延後取得向量庫：只在 text commit 之後才呼叫，避免向量庫初始化（重建 HNSW 等）拖慢文字進入畫布 */
  getStore?: () => Promise<StoreResolution>;
  /** 超過這個 chunk 數就略過向量化（文字與圖譜不受影響）。預設 MAX_EMBED_CHUNKS；測試可調高。 */
  maxEmbedChunks?: number;
  /** DECONSTRUCT 的切 chunk 實作（例如 Worker 版）。沒有提供時在呼叫端執行緒同步切。 */
  chunker?: Chunker;
  /** 直接注入向量庫（測試用；與 getStore 擇一） */
  store?: VectorStore;
  /** 直接注入 store 時，沒有 store 的原因 */
  storeUnavailableReason?: string;
}

/** 本輪尚未接入實作的階段：標 skipped，進度條不動。 */
const SKIPPED: Record<string, string> = {
  RECOMBINE: "未接入（待 embedding / 圖譜輪次）",
  EVOLVE: "未接入",
  MANIFEST: "未接入（待畫布 / 輸出輪次）",
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const abortError = () => new DOMException("Aborted", "AbortError");
const isAbort = (e: unknown, signal?: AbortSignal): boolean => !!signal?.aborted || (e instanceof DOMException && e.name === "AbortError");

/**
 * 讓取消「立即生效」：signal 一 abort 就以 AbortError reject，不必等底層 promise（模型下載 / 推論）結束。
 * 底層工作無法真的被中止、會在背景繼續，但它的結果會被丟棄；store.ingest 在寫入 transaction 之前會再檢查一次 signal，
 * 所以取消之後它不會偷偷寫入向量。
 */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined); // 取消後底層才失敗的錯誤，不要變成 unhandled rejection
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

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
      if (signal?.aborted) throw abortError();
      hooks.onStage(id, { status: "done", progress: 1 });
      return out;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") hooks.onStage(id, { status: "cancelled" });
      else hooks.onStage(id, { status: "error", note: errMsg(e) });
      throw e;
    }
  };

  const { name, rawText } = await step("PARSE", (r) => parse(source, r, signal));
  const chunks = await step("DECONSTRUCT", (r) => deconstruct(rawText, r, signal, hooks.chunker));

  // ───────────── TEXT COMMIT POINT ─────────────
  // 文字是 primary data：PARSE 成功 + DECONSTRUCT 完成 + chunks 完整之後，先 commit 文字（持久化 + 加入畫布），
  // 再開始 LINK / embedding。向量是 derived data，之後成功、失敗或被取消都不影響已 commit 的文字。
  let text: { status: TextStatus; docId?: string; note?: string } = { status: "pending" };
  if (chunks.length > 0 && hooks.onTextReady) {
    throwIfAborted(signal); // 進入 commit 前最後一次檢查；通過後就不 rollback
    try {
      const res = await hooks.onTextReady({ name, rawText, chunks });
      text = { status: res.status, docId: res.docId, note: res.note };
    } catch (e) {
      // hook 自己出錯 = 無法確認文字已保存，保守視為 persist_failed（並因此不做向量化）
      console.error("[hyperforge] text commit 失敗：", e);
      text = { status: "persist_failed", note: `文字 commit 失敗：${errMsg(e)}` };
    }
  }

  let vectorStatus: VectorStatus = "unavailable";
  let ingestDocId: string | undefined;
  const keywords = await step("LINK", async (r) => {
    const kw = await link(chunks, (p) => r(p * 0.2), signal); // 取消會在這裡（逐 chunk）被觀察到：commit 之後取消 → 文字保留
    if (chunks.length === 0) {
      r(1, "沒有可處理的文字，略過向量化");
      return kw;
    }
    if (text.status === "persist_failed") {
      r(1, `文字未能保存，略過向量化（避免只有衍生資料、沒有原文）。${text.note ?? ""}`);
      return kw;
    }

    // 過大的文件只略過向量化：不取得向量庫、不載入模型，因此不會凍結頁面。文字（已 commit）與圖譜照常。
    const limit = hooks.maxEmbedChunks ?? MAX_EMBED_CHUNKS;
    if (exceedsEmbedLimit(chunks.length, limit)) {
      r(1, embedLimitNote(chunks.length, limit));
      return kw;
    }

    // 向量庫在 text commit 之後才惰性取得（init 可能很慢）；可被取消。
    let store = hooks.store;
    let reason = hooks.storeUnavailableReason;
    if (hooks.getStore) {
      try {
        const res = await raceAbort(hooks.getStore(), signal);
        store = res.store ?? undefined;
        reason = res.reason;
      } catch (e) {
        if (isAbort(e, signal)) throw abortError();
        console.error("[hyperforge] 取得向量庫失敗，略過向量化：", e);
        store = undefined;
        reason = `向量庫初始化失敗：${errMsg(e)}`;
      }
    }

    // 向量化是「附加能力」：任何失敗都只降級（vectorStatus = failed / unavailable，job 走 PARTIAL），
    // 文字照常交回；只有取消（AbortError）會往外丟。
    let canEmbed = false;
    let probeError: unknown;
    if (store) {
      try {
        canEmbed = await raceAbort(store.isAvailable(), signal);
      } catch (e) {
        if (isAbort(e, signal)) throw abortError();
        probeError = e;
      }
    }
    if (!store || !canEmbed) {
      const why = probeError ? `向量化可用性檢查失敗：${errMsg(probeError)}` : (reason ?? "模型未安裝");
      if (probeError) console.error("[hyperforge] 向量化可用性檢查失敗，略過向量化：", probeError);
      r(1, `向量化略過：${why}（不使用假向量；文字已保留）`);
      return kw;
    }
    try {
      const res = await raceAbort(store.ingest({ name, rawText, chunks }, (p) => r(0.2 + p * 0.8, `向量化 ${Math.round(p * 100)}%`), signal), signal);
      ingestDocId = res.docId;
      vectorStatus = "indexed";
      if (res.duplicate) r(1, "向量已存在，未重複建立");
    } catch (e) {
      if (isAbort(e, signal)) throw abortError();
      vectorStatus = "failed";
      console.error("[hyperforge] 向量化失敗，略過（文字已保留）：", e);
      r(1, `向量化失敗：${errMsg(e)}（不使用假向量；文字已保留）`);
    }
    return kw;
  });
  return { name, rawText, chunks, keywords, docId: text.docId ?? ingestDocId, textStatus: text.status, vectorStatus };
}
