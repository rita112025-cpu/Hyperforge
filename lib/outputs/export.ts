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

/** 下載二進位內容（例如 PNG）。檔名經 safeFilename 淨化，Blob URL 用完即 revoke。 */
export function downloadBlob(filename: string, blob: Blob, deps: DownloadDeps = defaultDownloadDeps()): string {
  const ext = filename.match(/\.[^.]*$/)?.[0] ?? "";
  const name = safeFilename(filename.replace(/\.[^.]*$/, "")) + ext;
  const url = deps.createObjectURL(blob);
  try {
    deps.click(url, name);
  } finally {
    deps.revokeObjectURL(url);
  }
  return name;
}

/** canvas.toBlob 的最小形狀（可注入）；回傳 null 代表產生失敗（記憶體不足、畫布過大…） */
export interface BlobCanvas {
  toBlob(cb: (b: Blob | null) => void, type?: string): void;
}

export function toPngBlob(canvas: BlobCanvas | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (!canvas) return resolve(null);
    try {
      canvas.toBlob((b) => resolve(b), "image/png");
    } catch {
      resolve(null);
    }
  });
}

export interface CopyImageDeps {
  /** ClipboardItem 建構子與 clipboard.write；任一不存在就視為不支援 */
  ClipboardItemCtor?: new (items: Record<string, Blob | Promise<Blob>>) => unknown;
  write?: (items: unknown[]) => Promise<void>;
}

export type CopyImageResult = { ok: true } | { ok: false; error: string };

export function defaultCopyImageDeps(): CopyImageDeps {
  if (typeof navigator === "undefined") return {};
  return {
    ClipboardItemCtor: typeof ClipboardItem === "undefined" ? undefined : (ClipboardItem as unknown as CopyImageDeps["ClipboardItemCtor"]),
    write: navigator.clipboard?.write ? (items) => navigator.clipboard.write(items as ClipboardItem[]) : undefined,
  };
}

/**
 * 複製圖片到剪貼簿。Safari 要求 ClipboardItem 的值是 Promise<Blob>（且需要使用者手勢），所以一律以 Promise 傳入；
 * 不支援或被拒絕時回傳原因，由呼叫端退回下載。
 */
export async function copyImage(blob: Blob, deps: CopyImageDeps = defaultCopyImageDeps()): Promise<CopyImageResult> {
  if (!deps.ClipboardItemCtor || !deps.write) return { ok: false, error: "此環境不支援複製圖片" };
  try {
    await deps.write([new deps.ClipboardItemCtor({ [blob.type || "image/png"]: Promise.resolve(blob) })]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.replace(/[。.]+$/, "") : String(e) };
  }
}
