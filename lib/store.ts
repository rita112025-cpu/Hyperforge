"use client";
import { create } from "zustand";
import { contentIdOf, docFromJobResult, loadStoredDocument, saveDocument } from "./graph/corpus";
import type { GraphDocument } from "./graph/types";
import { canRetryIndexing, jobStatusFor } from "./pipeline/doc-state";
import { embedLimitNote, exceedsEmbedLimit } from "./pipeline/limits";
import { initialStages, runPipeline } from "./pipeline/runner";
import type { DocInfo, DocVectorState, IngestJob, IngestSource, TextCommitPayload, TextCommitResult, VectorStatus } from "./pipeline/types";
import { getVectorStore } from "./vector/runtime";
import { getSharedDb } from "./vector/shared-db";

// 本輪僅 pipeline 狀態一個 slice（Yjs 等之後輪次再加）。模組層不碰 window。
interface PipelineSlice {
  jobs: IngestJob[];
  /**
   * 圖譜的「即時來源」：已 text commit 的文件（文字 + chunk 位移）。畫布直接使用，不需要再讀 DB，
   * 也與 embedding 完全無關：DECONSTRUCT 完成、文字 commit 的那一刻就會加入，不等向量化。
   */
  docs: GraphDocument[];
  /** 每份文件目前的文字 / 語意索引狀態（job、retry、以及重新整理後由 IndexedDB 推得，統一在這裡） */
  docInfo: Record<string, DocInfo>;
  ingest: (source: IngestSource) => Promise<void>;
  cancel: (id: string) => void;
  /**
   * 明確的「重新建立索引」（只由使用者觸發；沒有任何背景 / 定時 / 啟動時自動重試）。
   * 只對 文字已就緒 且 向量尚未完成 的文件有效：從 IndexedDB 取回已 commit 的 docs / chunks → embed → 補寫向量，
   * 不重新 PARSE / DECONSTRUCT，也不新增 document / chunks。
   */
  retryIndexing: (docId: string) => Promise<void>;
  /** 重新整理後，把由 IndexedDB 推得的文件狀態放進來（不覆蓋本次 session 已有的即時狀態） */
  seedDocInfo: (entries: Record<string, DocInfo>) => void;
}

const controllers = new Map<string, AbortController>();
let seq = 0;

function sourceName(s: IngestSource): string {
  if (s.kind === "file") return s.file.name;
  if (s.kind === "url") return s.url;
  return "貼上文字";
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 文字持久化：docs + chunks 在同一個 Dexie transaction 內寫入（見 saveDocument）。失敗如實回報，不吞掉。 */
async function persistText(payload: TextCommitPayload): Promise<{ ok: boolean; note: string }> {
  try {
    const saved = await saveDocument(getSharedDb(), payload);
    if (!saved) return { ok: false, note: "未寫入 IndexedDB（環境不支援 crypto.subtle）" };
    return { ok: true, note: saved.created ? "文字已存入 IndexedDB（重新整理後畫布可由此重建）" : "文字已存在於 IndexedDB" };
  } catch (e) {
    return { ok: false, note: `文字未能存入 IndexedDB：${errMsg(e)}` };
  }
}

export const useForge = create<PipelineSlice>((set, get) => {
  /** 更新單一文件的狀態。「已 indexed」的文件不會被某次 job 的結果降級（向量已經在 DB 裡）。 */
  const patchDoc = (docId: string, patch: Partial<DocInfo>) =>
    set((s) => {
      const cur: DocInfo = s.docInfo[docId] ?? { text: "pending", vector: "pending" };
      const keepIndexed = cur.vector === "indexed" && patch.vector !== undefined && patch.vector !== "indexed";
      const next: DocInfo = keepIndexed ? { ...cur, ...patch, vector: "indexed", vectorNote: cur.vectorNote, progress: undefined } : { ...cur, ...patch };
      return { docInfo: { ...s.docInfo, [docId]: next } };
    });
  const setVector = (docId: string, vector: DocVectorState, vectorNote?: string) => patchDoc(docId, { vector, vectorNote, progress: undefined });
  const linkNote = (jobId: string) => get().jobs.find((j) => j.id === jobId)?.stages.find((st) => st.id === "LINK")?.note;

  return {
    jobs: [],
    docs: [],
    docInfo: {},
    cancel: (id) => controllers.get(id)?.abort(),
    seedDocInfo: (entries) => set((s) => ({ docInfo: { ...entries, ...s.docInfo } })),

    ingest: async (source) => {
      const id = `job-${Date.now()}-${seq++}`;
      const ac = new AbortController();
      controllers.set(id, ac);
      const patchJob = (fn: (j: IngestJob) => IngestJob) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? fn(j) : j)) }));

      set((s) => ({
        jobs: [{ id, name: sourceName(source), stages: initialStages(), status: "running", textStatus: "pending", vectorStatus: "pending" }, ...s.jobs],
      }));

      /**
       * TEXT COMMIT POINT：runner 在 DECONSTRUCT 完成後、embedding 開始前呼叫一次。
       * 順序：先持久化（primary data），再加入畫布 corpus，最後更新狀態。進入之後不受取消影響，也不 rollback。
       */
      const onTextReady = async (payload: TextCommitPayload): Promise<TextCommitResult> => {
        const { id: docId } = await contentIdOf(payload.rawText);
        const persist = await persistText(payload);
        const status = persist.ok ? "ready" : "persist_failed";
        // 即使持久化失敗，文件仍加入本次 session 的畫布（UI 會明確標示「尚未儲存」）
        const doc = docFromJobResult(payload, docId);
        set((s) => (s.docs.some((d) => d.id === docId) ? s : { docs: [...s.docs, doc] }));
        patchDoc(docId, {
          text: status,
          textNote: persist.note,
          ...(status === "persist_failed"
            ? { vector: "unavailable", vectorNote: "文字未能保存，不建立向量（避免只有衍生資料、沒有原文）" }
            : get().docInfo[docId]?.vector === "indexed"
              ? {}
              : exceedsEmbedLimit(payload.chunks.length)
                ? { vector: "unavailable", vectorNote: embedLimitNote(payload.chunks.length), tooLarge: true }
                : { vector: "building", vectorNote: undefined }),
        });
        patchJob((j) => ({ ...j, textStatus: status, textNote: persist.note, docId }));
        return { status, docId, note: persist.note };
      };

      try {
        const context = await runPipeline(source, {
          signal: ac.signal,
          onTextReady,
          getStore: getVectorStore, // 向量庫在 text commit 之後才惰性取得，文字不等它初始化
          onStage: (stageId, patch) =>
            patchJob((j) => ({ ...j, stages: j.stages.map((st) => (st.id === stageId ? { ...st, ...patch } : st)) })),
        });
        const { textStatus, vectorStatus } = context;
        patchJob((j) => ({
          ...j,
          status: jobStatusFor(textStatus, vectorStatus),
          context,
          textStatus,
          vectorStatus,
          textNote: j.textNote ?? (textStatus === "pending" ? "沒有可處理的文字（空內容）" : undefined),
        }));
        if (context.docId) setVector(context.docId, vectorStatus, vectorStatus === "indexed" ? undefined : linkNote(id));
      } catch (e) {
        const cancelled = e instanceof DOMException && e.name === "AbortError";
        const docId = get().jobs.find((j) => j.id === id)?.docId;
        if (cancelled) {
          // 取消 ≠ partial：使用者主動取消。text commit 之後取消，文字保留（不 rollback），只有向量化被取消。
          patchJob((j) => ({ ...j, status: "cancelled", vectorStatus: "cancelled" as VectorStatus }));
          if (docId) setVector(docId, "cancelled", "已取消索引");
        } else {
          patchJob((j) => ({ ...j, status: "error", error: errMsg(e) }));
          if (docId) setVector(docId, "failed", errMsg(e));
        }
      } finally {
        controllers.delete(id);
      }
    },

    retryIndexing: async (docId) => {
      if (!canRetryIndexing(get().docInfo[docId])) return; // 非 text ready / 已 indexed / 建立中：不做事
      patchDoc(docId, { vector: "building", vectorNote: undefined, progress: 0 });
      try {
        const stored = await loadStoredDocument(getSharedDb(), docId);
        if (!stored) return setVector(docId, "failed", "IndexedDB 內找不到這份文件的文字，無法建立索引");
        if (exceedsEmbedLimit(stored.chunks.length)) {
          // 保險：UI 不會對 tooLarge 文件顯示重試，但直接呼叫 action 也不能繞過上限
          patchDoc(docId, { tooLarge: true });
          return setVector(docId, "unavailable", embedLimitNote(stored.chunks.length));
        }
        const { store, reason } = await getVectorStore();
        if (!store) return setVector(docId, "unavailable", reason ?? "向量庫無法使用");
        if (!(await store.isAvailable())) return setVector(docId, "unavailable", reason ?? "模型未安裝（請執行 npm run fetch-model）");
        // ingest 對「文字已存在、向量不存在」的文件只補寫向量；向量已存在則不重複 embedding
        const res = await store.ingest(stored, (p) => patchDoc(docId, { progress: p }));
        setVector(docId, "indexed", res.duplicate ? "向量已存在，未重複建立" : undefined);
      } catch (e) {
        console.error("[hyperforge] 重新建立索引失敗（文字不受影響）：", e);
        setVector(docId, "failed", errMsg(e));
      }
    },
  };
});
