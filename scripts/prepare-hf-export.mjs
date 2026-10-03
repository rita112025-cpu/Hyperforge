import { readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { MODELS } from "./fetch-model.mjs";

/** Validate the self-hosted runtime assets, then prune only the exported copy. */
export async function prepareHfExport(repoRoot = process.cwd()) {
  const out = resolve(repoRoot, "out");
  await stat(join(out, "index.html"));
  await stat(join(out, "_next"));
  const model = MODELS.multilingual;
  for (const file of model.files) {
    const path = join(out, "models", model.repo, file.path);
    if ((await stat(path)).size !== file.size) {
      throw new Error(`HF export model asset has the wrong size: ${path}`);
    }
  }
  const wasmFiles = (await readdir(join(out, "ort"))).filter((name) => /^ort-wasm.*\.wasm$/.test(name));
  if (!wasmFiles.includes("ort-wasm.wasm") || !wasmFiles.includes("ort-wasm-simd.wasm")) {
    throw new Error("HF export is missing ORT WASM assets. Use the existing public/ort files.");
  }
  for (const name of wasmFiles) {
    if ((await stat(join(out, "ort", name))).size === 0) throw new Error(`Empty WASM asset: ${name}`);
  }
  const unused = resolve(out, "models", MODELS["minilm-l6"].repo);
  const withinOut = relative(out, unused);
  if (!withinOut || withinOut.startsWith(`..${sep}`) || withinOut === "..") {
    throw new Error("Refusing to prune a path outside the HF export.");
  }
  await rm(unused, { recursive: true, force: true });
  console.log(`HF static export ready: ${out}`);
  console.log("Excluded only out/models/Xenova/all-MiniLM-L6-v2; local public/models is unchanged.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await prepareHfExport();
}
