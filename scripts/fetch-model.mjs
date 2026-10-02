// 下載 embedding 模型檔到 public/models/（自託管，離線可用）。
// 每個模型都固定 HF commit revision；每個檔案都寫死 byte size 與 SHA256。
//  - onnx / tokenizer.json：SHA256 為 HF LFS 公布的 oid（取自 /api/models/<repo>/tree/<commit>?recursive=1）。
//  - 其餘小檔非 LFS，無上游公布雜湊：我對該 commit 的 raw 內容獨立重算後寫死（一次性人工確認）。
// 授權請自行在各模型的 HF 頁面核對。
//
// 用法：node scripts/fetch-model.mjs [--model=multilingual|minilm-l6]   （預設 multilingual）
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const MODELS = {
  multilingual: {
    repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    commit: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
    files: [
      { path: "config.json", size: 673, sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7" },
      { path: "tokenizer_config.json", size: 496, sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2" },
      { path: "special_tokens_map.json", size: 280, sha256: "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f" },
      { path: "tokenizer.json", size: 17082913, sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441" },
      {
        path: "onnx/model_quantized.onnx",
        size: 118308126,
        sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
      },
    ],
  },
  // 英文模型：保留支援，但不是 production 預設
  "minilm-l6": {
    repo: "Xenova/all-MiniLM-L6-v2",
    commit: "751bff37182d3f1213fa05d7196b954e230abad9",
    files: [
      { path: "config.json", size: 650, sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7" },
      { path: "tokenizer.json", size: 711661, sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0" },
      { path: "tokenizer_config.json", size: 366, sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3" },
      { path: "special_tokens_map.json", size: 125, sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3" },
      {
        path: "onnx/model_quantized.onnx",
        size: 22972370,
        sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
      },
    ],
  },
};

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function valid(file, dest) {
  try {
    if ((await stat(dest)).size !== file.size) return false;
    return file.sha256 ? sha(await readFile(dest)) === file.sha256 : true;
  } catch {
    return false;
  }
}

/** 下載到暫存檔 → 驗大小與 SHA → 通過才 rename；失敗刪暫存並丟錯。已存在且相符則跳過。 */
export async function ensureFile(file, baseUrl, outDir) {
  const dest = join(outDir, file.path);
  if (await valid(file, dest)) return "skip";
  const res = await fetch(`${baseUrl}/${file.path}`);
  if (!res.ok) throw new Error(`下載失敗 ${file.path}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== file.size) throw new Error(`${file.path} 大小不符：${buf.length} ≠ ${file.size}`);
  if (file.sha256 && sha(buf) !== file.sha256) throw new Error(`${file.path} SHA256 不符`);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  try {
    await writeFile(tmp, buf);
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return "downloaded";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? "multilingual";
  const m = MODELS[arg];
  if (!m) {
    console.error(`未知模型 ${arg}；可用：${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }
  const base = `https://huggingface.co/${m.repo}/resolve/${m.commit}`;
  const out = join(process.cwd(), "public", "models", ...m.repo.split("/"));
  try {
    for (const f of m.files) console.log(`${await ensureFile(f, base, out)}  ${m.repo}/${f.path}`);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
