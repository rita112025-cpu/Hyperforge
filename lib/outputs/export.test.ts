import { describe, expect, it, vi } from "vitest";
import { copyText, downloadText, safeFilename, type DownloadDeps } from "./export";

describe("safeFilename", () => {
  it("移除路徑分隔與 Windows 保留字元、控制字元；保留中文", () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(safeFilename("管線規範 摘要")).toBe("管線規範 摘要");
    expect(safeFilename("a\u0000b\u001fc")).toBe("abc");
  });
  it("前後的點與空白被移除（避免隱藏檔 / .. ）；空字串用 fallback；限制長度", () => {
    expect(safeFilename("..hidden. ")).toBe("hidden");
    expect(safeFilename("   ")).toBe("hyperforge");
    expect(safeFilename("", "x")).toBe("x");
    expect(Array.from(safeFilename("字".repeat(500))).length).toBe(80);
  });
});

describe("copyText", () => {
  it("clipboard 可用：成功、method=clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyText("hi", { clipboard: { writeText } })).toEqual({ ok: true, method: "clipboard" });
    expect(writeText).toHaveBeenCalledWith("hi");
  });
  it("clipboard 被拒絕：退到 legacy；legacy 成功 → method=legacy", async () => {
    const r = await copyText("hi", {
      clipboard: { writeText: async () => Promise.reject(new Error("NotAllowedError")) },
      legacyCopy: () => true,
    });
    expect(r).toEqual({ ok: true, method: "legacy" });
  });
  it("都失敗：回報原因並建議改用下載（不丟出）", async () => {
    const r = await copyText("hi", {
      clipboard: { writeText: async () => Promise.reject(new Error("NotAllowedError")) },
      legacyCopy: () => false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("NotAllowedError");
      expect(r.error).toContain("下載");
    }
  });
  it("沒有 clipboard 也沒有 legacy：說明需要 https 或 localhost", async () => {
    const r = await copyText("x", { clipboard: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("localhost");
  });
  it("legacy 丟例外也不外洩", async () => {
    const r = await copyText("x", {
      clipboard: null,
      legacyCopy: () => {
        throw new Error("boom");
      },
    });
    expect(r.ok).toBe(false);
  });
});

describe("downloadText", () => {
  it("檔名被淨化但副檔名保留；Blob 為指定 MIME + UTF-8；最後一定 revoke", async () => {
    const calls: string[] = [];
    let blob: Blob | null = null;
    const deps: DownloadDeps = {
      createObjectURL: (b) => {
        blob = b;
        calls.push("create");
        return "blob:fake";
      },
      revokeObjectURL: () => void calls.push("revoke"),
      click: (url, name) => void calls.push(`click:${url}:${name}`),
    };
    const name = downloadText("../管線:摘要.md", "# 標題\n內容", "text/markdown", deps);
    expect(name).toBe("_管線_摘要.md"); // "../" 變成 ".._" 再去掉前導點：不可能跳出目錄
    expect(calls).toEqual(["create", "click:blob:fake:_管線_摘要.md", "revoke"]);
    expect(blob!.type).toBe("text/markdown;charset=utf-8");
    expect(await blob!.text()).toBe("# 標題\n內容"); // 沒有 BOM、內容原樣
  });
  it("click 丟例外時仍會 revoke（不洩漏 object URL）", () => {
    const revoke = vi.fn();
    const deps: DownloadDeps = {
      createObjectURL: () => "blob:x",
      revokeObjectURL: revoke,
      click: () => {
        throw new Error("blocked");
      },
    };
    expect(() => downloadText("a.json", "{}", "application/json", deps)).toThrow("blocked");
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });
});
