export interface ModelSpec {
  /** HF repo，同時是 public/models 下的路徑 */
  repo: string;
  /** 固定的 HF commit revision（需與 scripts/fetch-model.mjs 一致） */
  revision: string;
  dim: number;
  /**
   * 設計用的最大序列長度（含 [CLS]/[SEP]）。
   * 來源：sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 模型卡，max_seq_length = 128。
   * tokenizer_config 的 model_max_length（512）只是上限，超過 128 品質會明顯下降，因此不以它當 window。
   */
  maxSeq: number;
  /** 寫入 DB meta 的識別；模型或 revision 改變就必須不同 */
  id: string;
}

export const MULTILINGUAL: ModelSpec = {
  repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
  dim: 384,
  maxSeq: 128,
  id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2@2c4055b(quantized)",
};

export function requiredFiles(spec: ModelSpec): string[] {
  const base = `/models/${spec.repo}`;
  return [
    `${base}/config.json`,
    `${base}/tokenizer.json`,
    `${base}/tokenizer_config.json`,
    `${base}/onnx/model_quantized.onnx`,
  ];
}
