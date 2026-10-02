import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DocumentList from "../../components/DocumentList";
import type { DocInfo } from "../pipeline/types";

const render = (docs: Array<{ id: string; name: string }>, docInfo: Record<string, DocInfo>) =>
  renderToStaticMarkup(createElement(DocumentList, { docs, docInfo, onRetry: vi.fn() }));
const retryButtons = (html: string) => (html.match(/data-testid="retry-indexing"/g) ?? []).length;

describe("DocumentList：文字 / 語意索引狀態與「重新建立索引」", () => {
  it("沒有文件時不顯示", () => {
    expect(render([], {})).toBe("");
  });

  it("重新建立索引按鈕只出現在 文字 ready 且 向量 pending / failed / cancelled / unavailable 的文件", () => {
    const docs = ["pending", "failed", "cancelled", "unavailable", "indexed", "building"].map((v) => ({ id: v, name: `${v}.txt` }));
    const info = Object.fromEntries(docs.map((d) => [d.id, { text: "ready", vector: d.id } as DocInfo]));
    expect(retryButtons(render(docs, info))).toBe(4);
    // 文字未保存：不開放
    expect(retryButtons(render([{ id: "x", name: "x" }], { x: { text: "persist_failed", vector: "unavailable" } }))).toBe(0);
    // 沒有狀態資料的文件：不開放
    expect(retryButtons(render([{ id: "y", name: "y" }], {}))).toBe(0);
  });

  it("取消後仍留在 Canvas 的文件：顯示「已取消索引 / 文字已保留」，不是錯誤樣式（沒有紅色）", () => {
    const html = render([{ id: "c", name: "c.txt" }], { c: { text: "ready", vector: "cancelled", vectorNote: "已取消索引" } });
    expect(html).toContain("語意索引：已取消（文字已保留）");
    expect(html).toContain("已取消索引");
    expect(html).toContain("重新建立索引");
    expect(html).not.toMatch(/text-red|bg-red|border-red/);
  });

  it("文字未保存：明確警示「尚未儲存，重新整理後可能遺失」（琥珀色警示，不是靜默）", () => {
    const html = render([{ id: "u", name: "u.txt" }], { u: { text: "persist_failed", vector: "unavailable", textNote: "IndexedDB 被封鎖" } });
    expect(html).toContain('data-testid="doc-unsaved"');
    expect(html).toContain("尚未儲存，重新整理後可能遺失");
    expect(html).toContain("IndexedDB 被封鎖");
  });

  it("建立中顯示進度；已完成的文件沒有按鈕與備註", () => {
    expect(render([{ id: "b", name: "b" }], { b: { text: "ready", vector: "building", progress: 0.42 } })).toContain("建立中 42%");
    const done = render([{ id: "d", name: "d" }], { d: { text: "ready", vector: "indexed" } });
    expect(done).toContain("語意索引：已完成");
    expect(retryButtons(done)).toBe(0);
  });

  it("文件名稱是使用者任意檔名：以純文字顯示（HTML 被跳脫，沒有 img / script / svg 元素）", () => {
    const evil = `<img src=x onerror="window.__HYPERFORGE_XSS__=1">.txt`;
    const html = render([{ id: "e", name: evil }], { e: { text: "ready", vector: "failed", vectorNote: `<script>window.__HYPERFORGE_XSS__=2</script>` } });
    expect(html).not.toMatch(/<\s*(img|script|svg)\b/i);
    expect(html).toContain("&lt;img src=x onerror=&quot;window.__HYPERFORGE_XSS__=1&quot;&gt;.txt");
    expect(html).toContain("&lt;script&gt;window.__HYPERFORGE_XSS__=2&lt;/script&gt;");
  });
});
