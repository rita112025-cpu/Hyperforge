// 把 @xenova/transformers 實際依賴解析到的 onnxruntime-web 的 wasm 複製到 public/ort/（自託管）。
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const req = createRequire(join(process.cwd(), "package.json"));
const xenovaDir = dirname(req.resolve("@xenova/transformers/package.json"));
const ortDir = dirname(createRequire(join(xenovaDir, "package.json")).resolve("onnxruntime-web/package.json"));
const SRC = join(ortDir, "dist");
const OUT = join(process.cwd(), "public", "ort");
await mkdir(OUT, { recursive: true });
const files = (await readdir(SRC)).filter((f) => /^ort-wasm.*\.wasm$/.test(f));
if (!files.length) throw new Error(`在 ${SRC} 找不到 ort-wasm*.wasm`);
for (const f of files) {
  await copyFile(join(SRC, f), join(OUT, f));
  console.log(`複製 ${f}  (from ${ortDir})`);
}
