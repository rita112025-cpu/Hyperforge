import { handleGraphRequest, type GraphAnalysis, type GraphRequest, type GraphResponse } from "./graph.worker";
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
}

const abortError = () => new DOMException("Aborted", "AbortError");

function defaultSpawn(): GraphWorkerLike {
  return new Worker(new URL("./graph.worker.ts", import.meta.url), { type: "module" }) as unknown as GraphWorkerLike;
}

interface Job {
  id: number;
  docs: GraphDocument[];
  includeDigest: boolean;
  resolve: (g: GraphAnalysis) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

let nextId = 1;

/**
 * 在 Web Worker 內建圖，主執行緒只收訊息。與 WorkerEmbedder 相同的模式：
 * 一次只送一個 request（FIFO）；取消進行中的請求 = 終止 Worker，排隊中的請求在新 Worker 繼續。
 * 不支援 Worker（或 Worker 建立失敗）時退回主執行緒同步 buildGraph。
 */
export class GraphClient {
  private worker: GraphWorkerLike | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;

  constructor(private deps: GraphClientDeps = {}) {}

  build(docs: GraphDocument[], signal?: AbortSignal): Promise<GraphModel> {
    return this.request(docs, false, signal).then((result) => result.graph);
  }

  analyze(docs: GraphDocument[], signal?: AbortSignal): Promise<GraphAnalysis> {
    return this.request(docs, true, signal);
  }

  private runSync(docs: GraphDocument[], includeDigest: boolean): GraphAnalysis {
    const res = handleGraphRequest({ id: 0, docs, includeDigest });
    if (!res.ok) throw new Error(res.error);
    return { graph: res.graph, digest: res.digest ?? null };
  }

  private request(docs: GraphDocument[], includeDigest: boolean, signal?: AbortSignal): Promise<GraphAnalysis> {
    if (signal?.aborted) return Promise.reject(abortError());
    const supported = this.deps.supported ?? (() => typeof Worker !== "undefined");
    if (!supported()) return Promise.resolve().then(() => this.runSync(docs, includeDigest));
    return new Promise<GraphAnalysis>((resolve, reject) => {
      const onAbort = () => this.abortJob(job);
      const job: Job = {
        id: nextId++,
        docs,
        includeDigest,
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

  private pump() {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    let worker: GraphWorkerLike;
    try {
      worker = this.worker ?? (this.deps.spawn ?? defaultSpawn)();
    } catch {
      // Worker 建立失敗（例如 CSP）：退回同步建圖
      job.cleanup();
      try {
        job.resolve(this.runSync(job.docs, job.includeDigest));
      } catch (e) {
        job.reject(e instanceof Error ? e : new Error(String(e)));
      }
      this.pump();
      return;
    }
    this.worker = worker;
    this.current = job;
    worker.onmessage = (e) => {
      const res = e.data;
      if (!this.current || res.id !== this.current.id) return;
      const done = this.current;
      this.current = null;
      done.cleanup();
      if (res.ok) done.resolve({ graph: res.graph, digest: res.digest ?? null });
      else done.reject(new Error(res.error));
      this.pump();
    };
    worker.onerror = (e) => {
      const done = this.current;
      this.current = null;
      this.killWorker();
      if (done) {
        done.cleanup();
        done.reject(new Error(e.message ?? "graph worker 錯誤"));
      }
      this.pump();
    };
    try {
      worker.postMessage({ id: job.id, docs: job.docs, includeDigest: job.includeDigest });
    } catch (e) {
      this.current = null;
      this.killWorker();
      job.cleanup();
      job.reject(e instanceof Error ? e : new Error(String(e)));
      this.pump();
    }
  }
}

let shared: GraphClient | null = null;
export function getGraphClient(): GraphClient {
  return (shared ??= new GraphClient());
}
