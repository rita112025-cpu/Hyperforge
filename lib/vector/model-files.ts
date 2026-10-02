import { MULTILINGUAL, requiredFiles, type ModelSpec } from "./model-spec";

export interface ModelFilesCheck {
  available: boolean;
  /** 缺少（或無效）的檔案 URL；fetch 本身失敗時為空，原因放在 error */
  missing: string[];
  error?: string;
}

export interface CheckOptions {
  /** true = 依序檢查，遇到第一個缺檔就停止（缺模型時只發 1 個請求，瀏覽器 console 只有 1 條 404）。預設平行檢查全部。 */
  stopAtFirstMissing?: boolean;
}

/**
 * 檢查自託管模型檔是否都存在（只對同源發 HEAD，不載入模型、不建立 embedder）。
 * Next 對缺檔回 404 頁（text/html），一併視為不存在。
 */
export async function checkModelFiles(
  spec: ModelSpec = MULTILINGUAL,
  fetchFn: typeof fetch = (...a) => fetch(...a),
  opts: CheckOptions = {},
): Promise<ModelFilesCheck> {
  try {
    const urls = requiredFiles(spec);
    const exists = async (url: string) => {
      const res = await fetchFn(url, { method: "HEAD", cache: "no-store" });
      return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
    };
    if (opts.stopAtFirstMissing) {
      for (const url of urls) if (!(await exists(url))) return { available: false, missing: [url] };
      return { available: true, missing: [] };
    }
    const oks = await Promise.all(urls.map(exists));
    const missing = urls.filter((_, i) => !oks[i]);
    return { available: missing.length === 0, missing };
  } catch (e) {
    return { available: false, missing: [], error: e instanceof Error ? e.message : String(e) };
  }
}
