# HyperForge · 混沌煉金工廠

Local-first 知識煉金工廠（開發中，目前為第 1 輪：投放口 + 管線動畫）。

## 開始

需要 Node.js LTS 20 或 22。首次 `npm install`，再取得自託管的模型與 wasm（約 24 MB，不入版控）：

```bash
npm install
npm run fetch-model   # 下載 all-MiniLM-L6-v2（量化，含 SHA256 校驗）到 public/models，複製 onnxruntime wasm 到 public/ort
npm run dev
npm run typecheck
npm test
```

## 目前狀態

| 階段 | 狀態 |
| --- | --- |
| PARSE / DECONSTRUCT / LINK | 文字類檔案與貼上文字為真實處理；token 為近似值（CJK 逐字、其餘以空白分詞）。LINK = 關鍵字 + 向量化（embedding → 單一 transaction 寫入 IndexedDB → 插入記憶體 HNSW）；向量化只在注入可用的 `Embedder` 時執行，否則略過並標 `indexed=false`、job 為 PARTIAL |
| RECOMBINE / EVOLVE / MANIFEST | skipped / 未接入，進度條不動；job 完成時顯示 PARTIAL，不是 DONE |
| PDF / 圖片 / 音訊 / 影片 / zip | 尚未支援，拖入會顯示錯誤 |
| URL（YouTube / GitHub / 網頁） | 尚未支援（不發任何網路請求），顯示錯誤 |
| DECONSTRUCT 進度 | 切 chunk 為同步純函式，進度一次跳到 100%，非逐塊真實進度 |
| 中文關鍵字 | LINK 的關鍵字抽取會濾掉單字 token，中文暫無關鍵字，待後續輪次 |

## 向量庫（第 2 輪）

- `lib/vector/hnsw.ts`：自建 HNSW（cosine、可重現 seed、可序列化）。
- `lib/vector/db.ts`：Dexie schema v1（`docs` / `chunks` / `vectors` / `meta`）。向量獨立成表；chunk 主鍵 `docId:index`，docId 為內容 SHA-256。未來欄位變更請新增 `version(2).upgrade`，不要改 `version(1)`。
- `lib/vector/index-store.ts`：寫入具原子性（取消或失敗不留半個 doc）；`meta` 記錄 embed 模型與維度，不符時拒絕（`ModelMismatchError`）。
- HNSW 索引只存記憶體，啟動時由 `vectors` 表重建；大型庫重建成本與索引持久化列待辦。
- **真 embedder**：`lib/vector/transformers-embedder.ts`（`@xenova/transformers` v2 舊套件，all-MiniLM-L6-v2 量化版，dim 384）。僅限瀏覽器；模型與 wasm 自託管於 `public/models`、`public/ort`，`allowRemoteModels=false`，不連外。`next.config.mjs` 把 `sharp`、`onnxruntime-node` alias 為 false。模型檔不存在時 `isAvailable()` 為 false，管線降級為 PARTIAL（不用假向量）。`lib/vector/runtime.ts` 以單一 promise 初始化全域 VectorStore。`FakeEmbedder`（`fake-embedder.test-util.ts`）僅供測試，`lib/no-fake-in-product.test.ts` 會檢查非測試檔不得 import。
- 內容雜湊用 `crypto.subtle`，只在 `localhost` 或 https 可用（用區網 IP 開 dev 會失敗）。

## Embedding 模型須知

- 模型：`Xenova/all-MiniLM-L6-v2`（量化，Apache-2.0，請自行在 HF 模型頁核對授權）。`npm run fetch-model` 固定到 commit `751bff37…`，並以寫死的 SHA256 校驗（下載到暫存檔、驗證通過才落檔）。
- **這是英文模型**：中文內容的向量品質有限（搜尋與連結會「能跑但不準」）。若要改用多語言模型（例如 paraphrase-multilingual-MiniLM-L12-v2，約 100MB+），需另行核准下載。
- MiniLM 最長 256 word pieces，因此每個 chunk 會切成 ≤150 近似 token 的視窗分別向量化再平均，避免靜默截斷。
- `@xenova/transformers` v2 已停止維護，內含較舊的 onnxruntime-web（1.14.0）。wasm 由 `scripts/copy-ort.mjs` 從該套件實際解析到的 onnxruntime-web 複製，版本與 JS 端一致。
- `next.config.mjs` 的 alias 只對 webpack 生效：**dev / build 請勿加 `--turbopack`**。
- 離線 PWA 之後需把 `public/models`、`public/ort` 加入預快取。
- `vitest` 不涵蓋真模型（只用注入的假 extractor 測邏輯）；真模型只在瀏覽器實測。

## 待辦備忘

- embedding 目前在主執行緒推論（numThreads=1，避免需要 COOP/COEP），應改 Web Worker。
- 巨檔切 chunk 會同步佔用主執行緒，需改為分批或 Worker。
- `Chunk` 的 start/end 位移已就緒；之後存 DB 需定 schema 版本。
- 若 `framer-motion` 與 React 19 出現 peer 衝突，請以 `^12` 為準。

- transformers.js / tesseract.js / pdfjs 的模型與 wasm 預設走 CDN，與零後端、離線 PWA 衝突，後續須自託管至 `public/`。
- `Hyperforge.html` 來源不明，未被引用；是否保留或搬至 `reference/` 由專案擁有者決定。
