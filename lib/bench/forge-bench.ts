import type { HNSW } from "../vector/hnsw";

/**
 * forge-lab 的量測工具。純函式為主；monitorMainThread 只依賴 setTimeout / PerformanceObserver（皆可選）。
 * 這裡的文字與向量都是「合成的量測負載」，不會寫進使用者的語料或向量庫。
 */

const ZH_TERMS = ["知識圖譜", "向量索引", "語意搜尋", "原子解構", "暗流連結", "黑曜石", "煉金工廠", "主執行緒", "背景運算", "持久化"];
const EN_TERMS = ["HyperForge", "Worker", "HNSW", "Dexie", "pipeline", "embedding", "recall", "benchmark", "IndexedDB", "transformer"];
const ZH_FRAMES = ["{a}讓{b}更穩定。", "沒有{a}，{b}就會卡住。", "{a}與{b}必須一起驗證。", "我們用{a}取代舊的{b}。"];
const EN_FRAMES = ["{a} keeps {b} responsive. ", "Without {a}, the {b} stalls. ", "{a} and {b} ship together. "];

/** 決定性 PRNG（mulberry32） */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 產生剛好 chars 個字元的中英混合文件（同 seed 結果相同），段落之間空一行。 */
export function generateBenchText(chars: number, seed = 1): string {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const parts: string[] = [];
  let len = 0;
  let sentences = 0;
  while (len < chars) {
    const zh = r() < 0.7;
    const terms = zh ? ZH_TERMS : EN_TERMS;
    let s = pick(zh ? ZH_FRAMES : EN_FRAMES).replace("{a}", pick(terms)).replace("{b}", pick(terms));
    if (++sentences % 8 === 0) s += "\n\n";
    parts.push(s);
    len += s.length;
  }
  return parts.join("").slice(0, chars);
}

/** 決定性的單位長度合成向量（只用於量測 HNSW 序列化 / 載入，不代表語意）。 */
export function syntheticVectors(count: number, dim: number, seed = 7): Float32Array[] {
  const r = rng(seed);
  return Array.from({ length: count }, () => {
    const v = new Float32Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      v[i] = r() * 2 - 1;
      norm += v[i] * v[i];
    }
    const inv = 1 / Math.sqrt(norm || 1);
    for (let i = 0; i < dim; i++) v[i] *= inv;
    return v;
  });
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** recall@k：以前 sample 筆向量為查詢，比較 HNSW 與暴力搜尋 top-k 的交集比例（0..1）。 */
export function recallAtK(index: HNSW, rows: ReadonlyArray<{ id: string; vec: Float32Array }>, k = 10, sample = 20): number {
  const queries = rows.slice(0, sample);
  if (queries.length === 0) return 0;
  const kk = Math.min(k, rows.length);
  let hit = 0;
  for (const q of queries) {
    const truth = rows
      .map((r) => ({ id: r.id, s: cosine(q.vec, r.vec) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, kk)
      .map((x) => x.id);
    const got = new Set(index.search(q.vec, kk).map((h) => h.id));
    hit += truth.filter((id) => got.has(id)).length;
  }
  return hit / (queries.length * kk);
}

export interface MainThreadReport {
  /** 計時器最大延遲（ms）：主執行緒被佔住最久的一段 */
  maxBlockMs: number;
  /** PerformanceObserver longtask 的最長任務；瀏覽器不支援時為 null */
  longestTaskMs: number | null;
  longTaskCount: number;
}

/** 開始量測主執行緒阻塞；回傳的 stop() 結束量測並給出報告。 */
export function monitorMainThread(intervalMs = 10): { stop(): MainThreadReport } {
  let maxBlockMs = 0;
  let expected = performance.now() + intervalMs;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const now = performance.now();
    maxBlockMs = Math.max(maxBlockMs, now - expected);
    expected = now + intervalMs;
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  let longestTaskMs: number | null = null;
  let longTaskCount = 0;
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    longestTaskMs = 0;
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTaskCount++;
        longestTaskMs = Math.max(longestTaskMs ?? 0, e.duration);
      }
    });
    observer.observe({ type: "longtask" });
  }

  return {
    stop() {
      clearTimeout(timer);
      if (observer) {
        for (const e of observer.takeRecords()) {
          longTaskCount++;
          longestTaskMs = Math.max(longestTaskMs ?? 0, e.duration);
        }
        observer.disconnect();
      }
      return { maxBlockMs: Math.max(0, maxBlockMs), longestTaskMs, longTaskCount };
    },
  };
}

/** 讓出主執行緒一次（讓計時器 / UI 有機會跑）。 */
export const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
