import {
  createGraphHost,
  type GraphHost,
  type GraphRequest,
  type GraphResponse,
  type GraphStage,
  type GraphStageTimings,
} from "./graph-protocol";
import type { GraphDocument, GraphModel } from "./types";

export interface GraphWorkerLike {
  postMessage(message: GraphRequest): void;
  terminate(): void;
  onmessage: ((e: { data: GraphResponse }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export interface GraphClientDeps {
  spawn?: () => GraphWorkerLike;
  supported?: () => boolean;
  /** 取消進行中的請求後，等 Worker 回報 done 的時間；逾時（或 0）就直接 terminate。 */
  abortGraceMs?: number;
}

export interface GraphProgress {
  stage: GraphStage;
  progress: number;
}

export interface GraphBuildOptions {
  signal?: AbortSignal;
  onProgress?: (p: GraphProgress) => void;
}

export interface GraphBuildResult {
  graph: GraphModel;
  /** 只有 buildFromText 會有：Worker 切好 chunk 的文件 */
  doc?: GraphDocument;
  durationMs: number;
  stageMs: GraphStageTimings;
}

export interface GraphClientStats {
  /** 排隊中（尚未送進 Worker）的請求數 */
  queued: number;
  running: boolean;
  stage: GraphStage | null;
  workerAlive: boolean;
  /** Worker 無法使用、改在主執行緒建圖 */
  fallback: boolean;
  completed: number;
  failed: number;
  aborted: number;
  lastDurationMs: number | null;
}

type BuildPayload = { type: "build"; docs: GraphDocument[] } | { type: "build-text"; name: string; rawText: string };

interface Job {
  id: number;
  payload: BuildPayload;
  onProgress?: (p: GraphProgress) => void;
  resolve: (r: GraphBuildResult) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
  settled: boolean;
}

const abortError = () => new DOMException("Aborted", "AbortError");
const DEFAULT_ABORT_GRACE_MS = 150;

function defaultSpawn(): GraphWorkerLike {
  return new Worker(new URL("./graph.worker.ts", import.meta.url), { type: "module" }) as unknown as GraphWorkerLike;
}

/** 主執行緒 fallback：與 Worker 共用 createGraphHost，介面與 Worker 相同。 */
function inProcessWorker(): GraphWorkerLike {
  let host: GraphHost | null = null;
  const w: GraphWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      host ??= createGraphHost((m) => w.onmessage?.({ data: m }));
      host.onMessage(message);
    },
    terminate() {
      w.onmessage = null;
    },
  };
  return w;
}

let nextId = 1;

/**
 * 在 Web Worker 內建圖，主執行緒只收訊息。與 WorkerEmbedder 相同的模式：
 * - 一次只送一個 request（FIFO 佇列在這裡）；Worker 端另有 AbortController。
 * - 取消進行中的請求：立即 reject(AbortError)、送 abort 給 Worker；Worker 在段與段之間停下並回 done，
 *   超過 abortGraceMs 沒回就 terminate（建圖的同步段落無法中斷）。排隊中的請求在同一個或新的 Worker 繼續。
 * - 不支援 Worker（或 Worker 建立失敗）時退回主執行緒，走同一份 createGraphHost。
 */
export class GraphClient {
  private worker: GraphWorkerLike | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;
  private stage: GraphStage | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private fallback = false;
  private counts = { completed: 0, failed: 0, aborted: 0 };
  private lastDurationMs: number | null = null;

  constructor(private deps: GraphClientDeps = {}) {}

  build(docs: GraphDocument[], opts: GraphBuildOptions = {}): Promise<GraphModel> {
    return this.enqueue({ type: "build", docs }, opts).then((r) => r.graph);
  }

  /** 原文直接送進 Worker（chunk 切分也不佔主執行緒）。 */
  buildFromText(name: string, rawText: string, opts: GraphBuildOptions = {}): Promise<GraphBuildResult> {
    return this.enqueue({ type: "build-text", name, rawText }, opts);
  }

  getStats(): GraphClientStats {
    return {
      queued: this.queue.length,
      running: this.current !== null && !this.current.settled,
      stage: this.stage,
      workerAlive: this.worker !== null && !this.fallback,
      fallback: this.fallback,
      ...this.counts,
      lastDurationMs: this.lastDurationMs,
    };
  }

  /** 取消所有進行中與排隊中的請求；client 之後仍可使用。 */
  abortAll(): void {
    for (const job of this.queue.splice(0)) this.settle(job, abortError());
    if (this.current) this.abortJob(this.current);
  }

  dispose(): void {
    for (const job of this.queue.splice(0)) this.settle(job, abortError());
    if (this.current) this.settle(this.current, abortError());
    this.current = null;
    this.killWorker();
  }

  private enqueue(payload: BuildPayload, { signal, onProgress }: GraphBuildOptions): Promise<GraphBuildResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<GraphBuildResult>((resolve, reject) => {
      const onAbort = () => this.abortJob(job);
      const job: Job = {
        id: nextId++,
        payload,
        onProgress,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
        settled: false,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private settle(job: Job, outcome: Error | GraphBuildResult): void {
    if (job.settled) return;
    job.settled = true;
    job.cleanup();
    if (outcome instanceof Error) {
      if (outcome instanceof DOMException && outcome.name === "AbortError") this.counts.aborted++;
      else this.counts.failed++;
      job.reject(outcome);
    } else {
      this.counts.completed++;
      this.lastDurationMs = outcome.durationMs;
      job.resolve(outcome);
    }
  }

  private killWorker(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.stage = null;
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private abortJob(job: Job): void {
    const i = this.queue.indexOf(job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.settle(job, abortError());
      return;
    }
    if (this.current !== job || job.settled) return;
    this.settle(job, abortError());
    const grace = this.deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    if (grace <= 0 || !this.worker) {
      this.finishCurrent(true);
      return;
    }
    this.worker.postMessage({ type: "abort", id: job.id });
    this.graceTimer = setTimeout(() => this.finishCurrent(true), grace);
  }

  /** 結束目前的請求並送出下一個；kill = Worker 狀態不可信（逾時 / 錯誤），丟棄。 */
  private finishCurrent(kill: boolean): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.current = null;
    this.stage = null;
    if (kill) this.killWorker();
    this.pump();
  }

  private ensureWorker(): GraphWorkerLike {
    if (this.worker) return this.worker;
    const supported = this.deps.supported ?? (() => typeof Worker !== "undefined");
    let w: GraphWorkerLike;
    if (this.fallback || !supported()) {
      this.fallback = true;
      w = inProcessWorker();
    } else {
      try {
        w = (this.deps.spawn ?? defaultSpawn)();
      } catch {
        // Worker 建立失敗（例如 CSP）：退回主執行緒
        this.fallback = true;
        w = inProcessWorker();
      }
    }
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => {
      const job = this.current;
      if (job) this.settle(job, new Error(e.message ?? "graph worker 錯誤"));
      this.finishCurrent(true);
    };
    this.worker = w;
    return w;
  }

  private pump(): void {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    const req: GraphRequest = job.payload.type === "build"
      ? { type: "build", id: job.id, docs: job.payload.docs }
      : { type: "build-text", id: job.id, name: job.payload.name, rawText: job.payload.rawText };
    this.ensureWorker().postMessage(req);
  }

  private onMessage(res: GraphResponse): void {
    const job = this.current;
    if (!job || res.id !== job.id) return; // 過期 / 陌生訊息：忽略
    switch (res.type) {
      case "progress":
        this.stage = res.stage;
        if (!job.settled) job.onProgress?.({ stage: res.stage, progress: res.progress });
        return;
      case "graph":
        this.settle(job, { graph: res.graph, doc: res.doc, durationMs: res.durationMs, stageMs: res.stageMs });
        return;
      case "error":
        this.settle(job, res.aborted ? abortError() : new Error(res.error));
        return;
      case "done":
        this.finishCurrent(false);
        return;
    }
  }
}

let shared: GraphClient | null = null;
export function getGraphClient(): GraphClient {
  return (shared ??= new GraphClient());
}
