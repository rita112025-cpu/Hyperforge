import type { Chunk } from "./chunker";
import { runDeconstruct, type DeconstructRequest, type DeconstructResponse } from "./deconstruct-core";

export interface DeconstructWorkerLike {
  postMessage(message: DeconstructRequest): void;
  terminate(): void;
  onmessage: ((e: { data: DeconstructResponse }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export interface DeconstructClientDeps {
  spawn?: () => DeconstructWorkerLike;
  supported?: () => boolean;
}

const abortError = () => new DOMException("Aborted", "AbortError");

function defaultSpawn(): DeconstructWorkerLike {
  return new Worker(new URL("./deconstruct.worker.ts", import.meta.url), { type: "module" }) as unknown as DeconstructWorkerLike;
}

interface Job {
  id: number;
  rawText: string;
  resolve: (c: Chunk[]) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

let nextId = 1;

/** 同步 fallback：與 Worker 共用 runDeconstruct，演算法錯誤照樣 reject（保留錯誤訊息）。 */
function runSync(rawText: string): Chunk[] {
  const res = runDeconstruct({ id: 0, rawText });
  if (!res.ok) throw new Error(res.error);
  return res.chunks;
}

/**
 * 在 Web Worker 內切 chunk。模式同 GraphClient：
 * - 一次只送一個 request（FIFO）；取消進行中的 = 終止 Worker，排隊中的在新 Worker 繼續。
 * - Worker 不存在 / constructor throw / 尚未成功回應前就 onerror（初始化失敗）→ 該請求退回同步核心；
 *   初始化失敗後本 client 不再嘗試 Worker。
 * - Worker 已證明可用後的執行錯誤、或演算法錯誤（ok:false）→ reject，並保留錯誤訊息。
 * - 只接受「目前進行中那個 id」的回應；終止的 Worker handler 一律拆除，stale response 不可能配到新請求。
 */
export class DeconstructClient {
  private worker: DeconstructWorkerLike | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;
  private healthy = false;
  private disabled = false;

  constructor(private deps: DeconstructClientDeps = {}) {}

  deconstruct(rawText: string, signal?: AbortSignal): Promise<Chunk[]> {
    if (signal?.aborted) return Promise.reject(abortError());
    const supported = this.deps.supported ?? (() => typeof Worker !== "undefined");
    if (this.disabled || !supported()) return Promise.resolve().then(() => runSync(rawText));
    return new Promise<Chunk[]>((resolve, reject) => {
      const onAbort = () => this.abortJob(job);
      const job: Job = {
        id: nextId++,
        rawText,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  dispose(): void {
    this.killWorker();
    const pending = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const j of pending) {
      j.cleanup();
      j.reject(abortError());
    }
  }

  private killWorker() {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private abortJob(job: Job) {
    job.cleanup();
    if (this.current === job) {
      this.current = null;
      this.killWorker();
      job.reject(abortError());
      this.pump();
      return;
    }
    const i = this.queue.indexOf(job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      job.reject(abortError());
    }
  }

  private fallback(job: Job) {
    job.cleanup();
    try {
      job.resolve(runSync(job.rawText));
    } catch (e) {
      job.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    let worker: DeconstructWorkerLike;
    try {
      worker = this.worker ?? (this.deps.spawn ?? defaultSpawn)();
    } catch {
      this.disabled = true;
      this.fallback(job);
      this.pump();
      return;
    }
    this.worker = worker;
    this.current = job;
    worker.onmessage = (e) => {
      const res = e.data;
      if (!this.current || res.id !== this.current.id) return; // stale
      const done = this.current;
      this.current = null;
      this.healthy = true;
      done.cleanup();
      if (res.ok) done.resolve(res.chunks);
      else done.reject(new Error(res.error));
      this.pump();
    };
    worker.onerror = (e) => {
      const done = this.current;
      this.current = null;
      const wasHealthy = this.healthy;
      this.killWorker();
      this.healthy = false;
      if (done) {
        if (wasHealthy) {
          done.cleanup();
          done.reject(new Error(e.message ?? "deconstruct worker 錯誤"));
        } else {
          this.disabled = true; // 初始化失敗（例如 script 載入失敗 / CSP）
          this.fallback(done);
        }
      }
      this.pump();
    };
    worker.postMessage({ id: job.id, rawText: job.rawText });
  }
}

let shared: DeconstructClient | null = null;
export function getDeconstructClient(): DeconstructClient {
  return (shared ??= new DeconstructClient());
}
