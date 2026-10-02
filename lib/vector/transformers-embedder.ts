import type { Embedder } from "./embedder";
import { checkModelFiles } from "./model-files";
import { MULTILINGUAL, type ModelSpec } from "./model-spec";

/** 預留給 [CLS] / [SEP] 的 token 數 */
const SPECIAL_TOKENS = 2;
const BATCH = 32;

export type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

/** 以 tokenizer 實際輸出切 window 用；encode 不含特殊 token */
export interface Tok {
  encode(text: string): number[];
  decode(ids: number[]): string;
  /** tokenizer_config 的 model_max_length */
  maxLength: number;
}

export interface EmbedderDeps {
  spec?: ModelSpec;
  /** 注入模型載入（測試用）；預設動態載入 @xenova/transformers */
  load?: () => Promise<{ extractor: Extractor; tokenizer: Tok }>;
  fetchFn?: typeof fetch;
}

function defaultLoader(spec: ModelSpec) {
  return async () => {
    // 只在 client 動態 import；模組頂層不得 import @xenova/transformers，否則 SSR 就會載入
    const { env, pipeline, AutoTokenizer } = await import("@xenova/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = "/models/";
    env.useBrowserCache = false;
    env.backends.onnx.wasm.wasmPaths = "/ort/";
    env.backends.onnx.wasm.numThreads = 1; // 多執行緒需 COOP/COEP
    const [extractor, raw] = await Promise.all([
      pipeline("feature-extraction", spec.repo, { quantized: true }),
      AutoTokenizer.from_pretrained(spec.repo),
    ]);
    const t = raw as unknown as {
      encode(text: string, pair: null, o: { add_special_tokens: boolean }): number[];
      decode(ids: number[], o: { skip_special_tokens: boolean }): string;
      model_max_length: number;
    };
    const tokenizer: Tok = {
      encode: (text) => t.encode(text, null, { add_special_tokens: false }),
      decode: (ids) => t.decode(ids, { skip_special_tokens: true }),
      maxLength: t.model_max_length,
    };
    return { extractor: extractor as unknown as Extractor, tokenizer };
  };
}

/** 把 ids 切成 ≤ size 的片段（純函式） */
export function sliceIds(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * 依 tokenizer 實際 token 數切 window（不用字數猜）：
 * 每段內容 ≤ maxSeq - 2 個 token（留給 [CLS]/[SEP]）。短文字原樣保留。
 * weight = 該 window 的 token 數，用於加權平均。
 */
export function toWindows(text: string, tok: Tok, maxSeq: number): { text: string; weight: number }[] {
  const limit = maxSeq - SPECIAL_TOKENS;
  const ids = tok.encode(text);
  if (ids.length <= limit) return [{ text, weight: Math.max(ids.length, 1) }];
  return sliceIds(ids, limit).map((part) => ({ text: tok.decode(part), weight: part.length }));
}

function weightedMeanNormalize(vs: Float32Array[], weights: number[], dim: number): Float32Array {
  const out = new Float32Array(dim);
  vs.forEach((v, k) => {
    for (let i = 0; i < dim; i++) out[i] += v[i] * weights[k];
  });
  let n = 0;
  for (let i = 0; i < dim; i++) n += out[i] * out[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

/**
 * paraphrase-multilingual-MiniLM-L12-v2（量化）。僅限瀏覽器端：模型與 wasm 自託管於 public/，不連外。
 * 成本：一個 500 近似 token 的 chunk 會被切成約 4–6 個 window，各做一次推論。
 */
export class TransformersEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  private spec: ModelSpec;
  private loaded: Promise<{ extractor: Extractor; tokenizer: Tok }> | null = null;
  private availableCache = false; // 只快取成功；失敗結果下次重查
  private load: () => Promise<{ extractor: Extractor; tokenizer: Tok }>;
  private fetchFn: typeof fetch;

  constructor(deps: EmbedderDeps = {}) {
    this.spec = deps.spec ?? MULTILINGUAL;
    this.id = this.spec.id;
    this.dim = this.spec.dim;
    this.load = deps.load ?? defaultLoader(this.spec);
    this.fetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
  }

  async isAvailable(): Promise<boolean> {
    if (this.availableCache) return true;
    this.availableCache = (await checkModelFiles(this.spec, this.fetchFn)).available;
    return this.availableCache;
  }

  private ensureLoaded() {
    this.loaded ??= this.load()
      .then((m) => {
        if (this.spec.maxSeq > m.tokenizer.maxLength) {
          throw new Error(`maxSeq ${this.spec.maxSeq} 超過 tokenizer.model_max_length ${m.tokenizer.maxLength}`);
        }
        return m;
      })
      .catch((e) => {
        this.loaded = null; // 失敗後允許重試
        throw new Error(`模型載入失敗：${e instanceof Error ? e.message : String(e)}`);
      });
    return this.loaded;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const { extractor, tokenizer } = await this.ensureLoaded();
    const windows: string[] = [];
    const weights: number[] = [];
    const owner: number[] = [];
    texts.forEach((t, i) =>
      toWindows(t, tokenizer, this.spec.maxSeq).forEach((w) => {
        windows.push(w.text);
        weights.push(w.weight);
        owner.push(i);
      }),
    );
    const vecs: Float32Array[] = [];
    for (let i = 0; i < windows.length; i += BATCH) {
      const batch = windows.slice(i, i + BATCH);
      const out = await extractor(batch, { pooling: "mean", normalize: true });
      const [n, dim] = out.dims;
      if (n !== batch.length || dim !== this.dim) throw new Error(`非預期的輸出形狀 [${out.dims.join(",")}]`);
      for (let k = 0; k < n; k++) vecs.push(out.data.slice(k * dim, (k + 1) * dim));
    }
    return texts.map((_, i) => {
      const idx = owner.flatMap((o, k) => (o === i ? [k] : []));
      return weightedMeanNormalize(
        idx.map((k) => vecs[k]),
        idx.map((k) => weights[k]),
        this.dim,
      );
    });
  }
}
