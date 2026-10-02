/**
 * 合成的「測試用」feature-extraction 模型（不是真模型，也沒有任何語意）。
 *
 * 目的：讓瀏覽器驗收能走「真的 TransformersEmbedder + @xenova/transformers + onnxruntime-web(WASM)」這整條路徑，
 * 在 HuggingFace 無法下載（例如被代理擋住）的環境下，也能驗證「向量化成功 / 補建索引 / 取消」等流程。
 *
 * 組成（檔案路徑與 lib/vector/model-spec.ts 的 requiredFiles 一致）：
 *   config.json / tokenizer.json / tokenizer_config.json：極小的 BERT 風格 WordPiece tokenizer（a-z、0-9 與其 ## 片段；其餘字元為 [UNK]）
 *   onnx/model_quantized.onnx：ONNX 圖 = Gather(embedding_table[VOCAB, DIM], input_ids)，輸出 last_hidden_state [batch, seq, DIM]
 *
 * 產生的向量只是「查表後 mean pooling + L2 normalize」：決定性、維度 384，但不代表語意。
 * 只在 scripts/e2e 內使用；不會被打包進 app、不會放進 public/。用 onnx-proto（onnxruntime-web 的傳遞依賴）編碼 ONNX。
 */
const { onnx } = require("onnx-proto");

const DIM = 384; // 與 lib/vector/model-spec.ts 的 MULTILINGUAL.dim 一致
const REPO = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

const SPECIAL = ["[PAD]", "[UNK]", "[CLS]", "[SEP]"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const VOCAB = [...SPECIAL, ...LETTERS, ...LETTERS.map((c) => `##${c}`)];

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function buildOnnx() {
  const rnd = lcg(12345);
  const table = new Float32Array(VOCAB.length * DIM);
  for (let i = 0; i < table.length; i++) table[i] = rnd() * 2 - 1;
  const shape = (...dims) => ({ dim: dims.map((d) => (typeof d === "string" ? { dimParam: d } : { dimValue: d })) });
  const model = onnx.ModelProto.create({
    irVersion: 8,
    producerName: "hyperforge-e2e-synthetic",
    opsetImport: [{ domain: "", version: 13 }],
    graph: {
      name: "synthetic_embedding_lookup",
      node: [
        {
          opType: "Gather",
          input: ["embedding_table", "input_ids"],
          output: ["last_hidden_state"],
          attribute: [{ name: "axis", type: onnx.AttributeProto.AttributeType.INT, i: 0 }],
        },
      ],
      initializer: [
        {
          name: "embedding_table",
          dims: [VOCAB.length, DIM],
          dataType: onnx.TensorProto.DataType.FLOAT,
          rawData: Buffer.from(table.buffer),
        },
      ],
      input: [{ name: "input_ids", type: { tensorType: { elemType: onnx.TensorProto.DataType.INT64, shape: shape("batch_size", "sequence_length") } } }],
      output: [{ name: "last_hidden_state", type: { tensorType: { elemType: onnx.TensorProto.DataType.FLOAT, shape: shape("batch_size", "sequence_length", DIM) } } }],
    },
  });
  return Buffer.from(onnx.ModelProto.encode(model).finish());
}

function tokenizerJson() {
  const vocab = Object.fromEntries(VOCAB.map((t, i) => [t, i]));
  const special = (id, content) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true });
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: SPECIAL.map((t, i) => special(i, t)),
    normalizer: { type: "BertNormalizer", clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
    pre_tokenizer: { type: "BertPreTokenizer" },
    post_processor: {
      type: "TemplateProcessing",
      single: [{ SpecialToken: { id: "[CLS]", type_id: 0 } }, { Sequence: { id: "A", type_id: 0 } }, { SpecialToken: { id: "[SEP]", type_id: 0 } }],
      pair: [
        { SpecialToken: { id: "[CLS]", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "[SEP]", type_id: 0 } },
        { Sequence: { id: "B", type_id: 1 } },
        { SpecialToken: { id: "[SEP]", type_id: 1 } },
      ],
      special_tokens: {
        "[CLS]": { id: "[CLS]", ids: [2], tokens: ["[CLS]"] },
        "[SEP]": { id: "[SEP]", ids: [3], tokens: ["[SEP]"] },
      },
    },
    decoder: { type: "WordPiece", prefix: "##", cleanup: true },
    model: { type: "WordPiece", unk_token: "[UNK]", continuing_subword_prefix: "##", max_input_chars_per_word: 100, vocab },
  };
}

/** 相對於 /models/<REPO>/ 的檔案內容 */
function modelFiles() {
  const json = (o) => Buffer.from(JSON.stringify(o));
  return {
    "config.json": json({
      model_type: "bert",
      architectures: ["BertModel"],
      hidden_size: DIM,
      num_hidden_layers: 1,
      num_attention_heads: 12,
      intermediate_size: 4 * DIM,
      vocab_size: VOCAB.length,
      max_position_embeddings: 512,
      type_vocab_size: 2,
      pad_token_id: 0,
    }),
    "tokenizer.json": json(tokenizerJson()),
    "tokenizer_config.json": json({
      tokenizer_class: "BertTokenizer",
      do_lower_case: true,
      model_max_length: 512,
      unk_token: "[UNK]",
      sep_token: "[SEP]",
      pad_token: "[PAD]",
      cls_token: "[CLS]",
      mask_token: "[MASK]",
    }),
    "onnx/model_quantized.onnx": buildOnnx(),
  };
}

module.exports = { DIM, REPO, VOCAB, modelFiles, buildOnnx };
