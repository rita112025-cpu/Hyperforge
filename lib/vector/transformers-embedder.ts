import { tokenSpans } from "../pipeline/chunker";
import type { Embedder } from "./embedder";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const BASE = `/models/${MODEL}`;
/** 缺任何一個，transformers.js 載入就會失敗，所以 availability 要全部檢查 */
export const REQUIRED_FILES = [
  `${BASE}/config.json`,
  `${BASE}/tokenizer.json`,
  `${BASE}/tokenizer_config.json`,
  `${BASE}/onnx/model_quantized.onnx`,
];

/**
 * MiniLM 最長 256 word pieces，超出會被靜默截斷。chunk 是 500「近似 token」，
 * 所以每個文字切成 ≤ WINDOW 個近似 token 的視窗分別 embed 再平均（英文約 1.3 pieces/word，150 留有餘裕）。
 */
export const WINDOW_TOKENS = 150;
const BATCH = 32;

export type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

export interface EmbedderDeps {
  /** 注入 pipeline 工廠（測試用）；預設動態載入 @xenova/transformers */
  loadExtractor?: () => Promise<Extractor>;
  fetchFn?: typeof fetch;
  windowTokens?: number;
}

async function defaultLoadExtractor(): Promise<Extractor> {
  // 只在 client 動態 import；模組頂層不得 import @xenova/transformers，否則 SSR 就會載入
  const { env, pipeline } = await import("@xenova/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = "/models/";
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = "/ort/";
  env.backends.onnx.wasm.numThreads = 1; // 多執行緒需 COOP/COEP
  return (await pipeline("feature-extraction", MODEL, { quantized: true })) as unknown as Extractor;
}

export function splitWindows(text: string, size: number): string[] {
  const spans = tokenSpans(text);
  if (spans.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < spans.length; i += size) {
    out.push(text.slice(spans[i].start, spans[Math.min(i + size, spans.length) - 1].end));
  }
  return out;
}

function meanNormalize(vs: Float32Array[], dim: number): Float32Array {
  const out = new Float32Array(dim);
  for (const v of vs) for (let i = 0; i < dim; i++) out[i] += v[i];
  let n = 0;
  for (let i = 0; i < dim; i++) n += out[i] * out[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

/**
 * all-MiniLM-L6-v2（量化，Apache-2.0，請自行在 HF 模型頁核對）。僅限瀏覽器端：模型與 wasm 自託管於 public/，不連外。
 * 注意：此為英文模型，中文向量品質有限。
 */
export class TransformersEmbedder implements Embedder {
  readonly id = `${MODEL}(quantized)`;
  readonly dim = 384;
  private extractor: Promise<Extractor> | null = null;
  private availableCache = false; // 只快取成功；失敗結果下次重查
  private deps: Required<EmbedderDeps>;

  constructor(deps: EmbedderDeps = {}) {
    this.deps = {
      loadExtractor: deps.loadExtractor ?? defaultLoadExtractor,
      fetchFn: deps.fetchFn ?? ((...a) => fetch(...a)),
      windowTokens: deps.windowTokens ?? WINDOW_TOKENS,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this.availableCache) return true;
    try {
      const results = await Promise.all(
        REQUIRED_FILES.map(async (url) => {
          const res = await this.deps.fetchFn(url, { method: "HEAD", cache: "no-store" });
          // Next 對缺檔回 404 頁（text/html），一併排除
          return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
        }),
      );
      this.availableCache = results.every(Boolean);
      return this.availableCache;
    } catch {
      return false;
    }
  }

  private load(): Promise<Extractor> {
    this.extractor ??= this.deps.loadExtractor().catch((e) => {
      this.extractor = null; // 失敗後允許重試
      throw new Error(`模型載入失敗：${e instanceof Error ? e.message : String(e)}`);
    });
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const extract = await this.load();
    const windows: string[] = [];
    const owner: number[] = [];
    texts.forEach((t, i) =>
      splitWindows(t, this.deps.windowTokens).forEach((w) => {
        windows.push(w);
        owner.push(i);
      }),
    );
    const vecs: Float32Array[] = [];
    for (let i = 0; i < windows.length; i += BATCH) {
      const batch = windows.slice(i, i + BATCH);
      const out = await extract(batch, { pooling: "mean", normalize: true });
      const [n, dim] = out.dims;
      if (n !== batch.length || dim !== this.dim) throw new Error(`非預期的輸出形狀 [${out.dims.join(",")}]`);
      for (let k = 0; k < n; k++) vecs.push(out.data.slice(k * dim, (k + 1) * dim));
    }
    return texts.map((_, i) => meanNormalize(vecs.filter((_, k) => owner[k] === i), this.dim));
  }
}
