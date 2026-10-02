import type { EmbedOptions, Embedder } from "./embedder";
import type { EmbedRequest, EmbedResponse } from "./embed-protocol";
import { checkModelFiles } from "./model-files";
import { MULTILINGUAL, type ModelSpec } from "./model-spec";

/** Worker 的最小形狀（測試用 fake 實作它；瀏覽器的 Worker 符合） */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  onmessageerror?: ((e: unknown) => void) | null;
}

export interface WorkerEmbedderDeps {
  spec?: ModelSpec;
  /** 建立 Worker。預設：new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" }) */
  spawn?: () => WorkerLike;
  /** 目前環境是否支援 Worker */
  supported?: () => boolean;
  fetchFn?: typeof fetch;
}

interface Job {
  id: number;
  texts: string[];
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

const abortError = () => new DOMException("Aborted", "AbortError");

function defaultSpawn(): WorkerLike {
  return new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

/**
 * 在 Web Worker 內做 embedding 的 Embedder（主執行緒只負責傳訊息）。
 *
 * - 一次只送一個 request 給 Worker（FIFO 佇列），所以取消「進行中」的請求只需要終止 Worker，
 *   排隊中的請求會在新的 Worker 上繼續，不會被牽連。這是「重新派送」尚未開始的請求，**不是**「失敗後重試」：
 *   被取消或失敗的那個請求不會再被執行（與 lib/no-auto-retry.test.ts 的「沒有自動重試」政策一致）。
 * - 過期回應：terminate 後舊 Worker 的 handler 一律拆除（onmessage = null），request id 全域遞增、
 *   且只接受「目前進行中那個 id」的回應，所以舊 Worker 補送的訊息不可能被配到新的請求。
 * - Worker 只在第一次 embed() 時才建立（不在模組載入、render 或 isAvailable 中建立）。
 * - 取消（AbortSignal）：立即 reject(AbortError)，並終止 Worker 以真的停止運算（模型之後在下次需要時重新載入）。
 * - Worker 錯誤 / crash：進行中的請求 reject、Worker 被丟棄；**不會自動重試那個請求**（維持「沒有自動重試」的政策）。
 * - Worker 不存在或無法建立：isAvailable() 為 false（原因「Worker 不可用」）。**不會退回主執行緒**——那會再次凍結頁面。
 */
export class WorkerEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  private readonly spec: ModelSpec;
  private readonly spawn: () => WorkerLike;
  private readonly supported: () => boolean;
  private readonly fetchFn: typeof fetch;
  private worker: WorkerLike | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;
  private nextId = 1;
  private availableCache = false;
  private reason: string | undefined;

  constructor(deps: WorkerEmbedderDeps = {}) {
    this.spec = deps.spec ?? MULTILINGUAL;
    this.id = this.spec.id;
    this.dim = this.spec.dim;
    this.spawn = deps.spawn ?? defaultSpawn;
    this.supported = deps.supported ?? (() => typeof Worker !== "undefined");
    this.fetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
    WorkerEmbedder.live.add(this);
  }

  unavailableReason(): string | undefined {
    return this.reason;
  }

  async isAvailable(): Promise<boolean> {
    if (this.availableCache) return true;
    if (!this.supported()) {
      this.reason = "Worker 不可用（此環境不支援 Web Worker；為避免凍結頁面，不退回主執行緒）";
      return false;
    }
    const check = await checkModelFiles(this.spec, this.fetchFn);
    this.reason = check.available ? undefined : "模型未安裝（請執行 npm run fetch-model）";
    this.availableCache = check.available;
    return check.available;
  }

  /** 目前是否有 Worker 存活（測試與除錯用） */
  get hasWorker(): boolean {
    return this.worker !== null;
  }

  /** 立即終止所有 Worker 並拒絕所有請求（開發時 HMR 重建模組、頁面卸載用，避免孤兒 Worker） */
  static disposeAll(): void {
    for (const e of [...WorkerEmbedder.live]) e.dispose();
  }
  private static live = new Set<WorkerEmbedder>();

  get queued(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<Float32Array[]>((resolve, reject) => {
      const job: Job = { id: this.nextId++, texts, resolve, reject, cleanup: () => undefined };
      if (signal) {
        const onAbort = () => this.abortJob(job);
        signal.addEventListener("abort", onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  /** 終止 Worker 並讓所有尚未完成的請求 reject（頁面卸載 / 測試清理用） */
  dispose(): void {
    const err = new Error("WorkerEmbedder 已關閉");
    this.dropWorker();
    for (const j of [this.current, ...this.queue]) if (j) this.settle(j, err);
    this.current = null;
    this.queue = [];
    WorkerEmbedder.live.delete(this);
  }

  // ───────────── internals ─────────────

  private settle(job: Job, outcome: Error | Float32Array[]): void {
    job.cleanup();
    if (outcome instanceof Error) job.reject(outcome);
    else job.resolve(outcome);
  }

  private dropWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    try {
      w.terminate();
    } catch {
      /* 已經終止 */
    }
  }

  private pump(): void {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    try {
      const w = this.ensureWorker();
      const req: EmbedRequest = { id: job.id, type: "embed", texts: job.texts };
      w.postMessage(req);
    } catch (e) {
      this.failCurrent(new Error(`無法啟動 embedding Worker：${e instanceof Error ? e.message : String(e)}`));
    }
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => this.failCurrent(new Error(`embedding Worker 發生錯誤：${e?.message ?? "未知錯誤"}`));
    w.onmessageerror = () => this.failCurrent(new Error("embedding Worker 回傳了無法解析的訊息"));
    this.worker = w;
    return w;
  }

  /** 目前的請求失敗：丟棄 Worker（可能已壞掉）、reject；佇列中的其他請求會在新的 Worker 上繼續。不重試失敗的那個。 */
  private failCurrent(err: Error): void {
    const job = this.current;
    this.current = null;
    this.dropWorker();
    if (job) this.settle(job, err);
    this.pump();
  }

  private onMessage(data: unknown): void {
    const res = data as Partial<EmbedResponse> | null;
    const job = this.current;
    if (!job || !res || typeof res !== "object" || res.id !== job.id) return; // 過期 / 陌生訊息：忽略
    if (res.ok === true && Array.isArray(res.vectors)) {
      const bad = res.vectors.length !== job.texts.length || res.vectors.some((v) => !(v instanceof Float32Array) || v.length !== this.dim);
      this.current = null;
      this.settle(job, bad ? new Error("embedding Worker 回傳的向量數量或維度不符") : res.vectors);
    } else {
      this.current = null;
      this.settle(job, new Error(res.ok === false && typeof res.error === "string" ? res.error : "embedding Worker 回傳了無效的回應"));
    }
    this.pump();
  }

  private abortJob(job: Job): void {
    const queuedAt = this.queue.indexOf(job);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1); // 還沒送出：直接移除，不影響 Worker
      this.settle(job, abortError());
      return;
    }
    if (this.current === job) {
      // 進行中：終止 Worker 才能真的停止運算；之後的請求會用新的 Worker
      this.current = null;
      this.dropWorker();
      this.settle(job, abortError());
      this.pump();
    }
  }
}
