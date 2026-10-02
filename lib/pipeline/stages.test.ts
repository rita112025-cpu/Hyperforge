import { describe, expect, it } from "vitest";
import { deconstruct, parse } from "./stages";

describe("parse", () => {
  it("0 byte 檔案：回傳空字串、progress 為有限數", async () => {
    const seen: number[] = [];
    const out = await parse({ kind: "file", file: new File([], "empty.txt", { type: "text/plain" }) }, (p) => seen.push(p));
    expect(out.rawText).toBe("");
    expect(seen.every(Number.isFinite)).toBe(true);
  });
  it("文字檔：讀出原文", async () => {
    const out = await parse({ kind: "file", file: new File(["你好 world"], "a.md") }, () => undefined);
    expect(out.rawText).toBe("你好 world");
  });
  it("不支援的檔案類型丟錯", async () => {
    await expect(parse({ kind: "file", file: new File(["x"], "a.pdf", { type: "application/pdf" }) }, () => undefined)).rejects.toThrow("尚未支援");
  });
  it("URL 丟錯（本輪不發請求）", async () => {
    await expect(parse({ kind: "url", url: "https://github.com/a/b", subtype: "github" }, () => undefined)).rejects.toThrow("尚未支援");
  });
});

describe("deconstruct", () => {
  it("空字串 → 0 chunk，progress 為 1", async () => {
    const seen: number[] = [];
    expect(await deconstruct("", (p) => seen.push(p))).toEqual([]);
    expect(seen).toEqual([1]);
  });
});
