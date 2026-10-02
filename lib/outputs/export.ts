/**
 * 複製與下載的小工具。瀏覽器 API 都可注入，Node 測試不需要 DOM。
 * 使用者的內容只會被當成「純文字」寫進剪貼簿 / Blob（text/markdown、application/json），不會被當成 HTML。
 */

/** 檔名：移除路徑與控制字元、Windows 保留字元，限制長度；空字串時用 fallback。 */
export function safeFilename(name: string, fallback = "hyperforge", maxLen = 80): string {
  const cleaned = Array.from(name)
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();
  const clipped = Array.from(cleaned).slice(0, maxLen).join("") || fallback;
  // Windows 保留裝置名稱（不分大小寫；也包含 "CON.txt" 這種帶副檔名的形式，所以只看第一個點之前）
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clipped.split(".")[0].trim()) ? `_${clipped}` : clipped;
}

export interface CopyDeps {
  clipboard?: { writeText(text: string): Promise<void> } | null;
  /** 舊式退路（execCommand）。回傳是否成功。 */
  legacyCopy?: (text: string) => boolean;
}

export type CopyResult = { ok: true; method: "clipboard" | "legacy" } | { ok: false; error: string };

/** 先用 navigator.clipboard（需要 https / localhost 與權限）；失敗再退到 execCommand；都不行就回報原因。 */
export async function copyText(text: string, deps: CopyDeps = defaultCopyDeps()): Promise<CopyResult> {
  let firstError = "";
  if (deps.clipboard) {
    try {
      await deps.clipboard.writeText(text);
      return { ok: true, method: "clipboard" };
    } catch (e) {
      firstError = e instanceof Error ? e.message : String(e);
    }
  } else {
    firstError = "此環境沒有 navigator.clipboard（需要 https 或 localhost）";
  }
  if (deps.legacyCopy) {
    try {
      if (deps.legacyCopy(text)) return { ok: true, method: "legacy" };
    } catch {
      /* 落到下面的錯誤回報 */
    }
  }
  return { ok: false, error: `無法複製：${firstError.replace(/[。.]+$/, "")}。可改用「下載」。` };
}

export function defaultCopyDeps(): CopyDeps {
  if (typeof navigator === "undefined" || typeof document === "undefined") return { clipboard: null };
  return {
    clipboard: navigator.clipboard ?? null,
    legacyCopy: (text) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        return document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    },
  };
}

export interface DownloadDeps {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  click(url: string, filename: string): void;
}

export function defaultDownloadDeps(): DownloadDeps {
  return {
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    click: (url, filename) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
  };
}

/** 下載文字檔（UTF-8，Markdown 與 JSON 皆不加 BOM）。 */
export function downloadText(filename: string, text: string, mime: string, deps: DownloadDeps = defaultDownloadDeps()): string {
  const name = safeFilename(filename.replace(/\.[^.]*$/, "")) + (filename.match(/\.[^.]*$/)?.[0] ?? "");
  const url = deps.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  try {
    deps.click(url, name);
  } finally {
    deps.revokeObjectURL(url);
  }
  return name;
}
