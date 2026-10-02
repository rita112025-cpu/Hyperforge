import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SourcePanel from "../../components/SourcePanel";
import { makeAlchemyNode } from "./alchemy";
import { buildGraph } from "./build";
import { truncateLabel } from "./draw";
import { buildSnippets } from "./snippets";
import type { GraphDocument } from "./types";

/** 規格指定的 hostile fixture（逐字） */
const HOSTILE = [
  `<img src=x onerror="window.__HYPERFORGE_XSS__=1">`,
  `<script>window.__HYPERFORGE_XSS__=2</script>`,
  `<svg onload="window.__HYPERFORGE_XSS__=3"></svg>`,
].join("\n");

// 重複兩次，讓 img / onerror / script / svg / onload / window 等 token 達到 freq ≥ 2 而成為節點
const TEXT = `${HOSTILE}\n${HOSTILE}\n`;
const doc: GraphDocument = { id: "hostile", name: `<b>evil</b>.html`, rawText: TEXT, chunks: [{ index: 0, start: 0, end: TEXT.length }] };
const docs = new Map([[doc.id, doc]]);
const graph = buildGraph([doc]);

/** 去掉真正的標籤、解碼 entity → 使用者實際看到的文字。（逸出後的 &lt; 不是標籤，不會被去掉。） */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

// Windows：URL.pathname 會得到 "/D:/..."，必須用 fileURLToPath；比較相對路徑前統一成正斜線
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const norm = (p: string) => p.split("\\").join("/");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === ".next" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("hostile HTML 以純文字呈現（阻擋測試）", () => {
  it("fixture 確實進入圖譜：產生了含有 onerror / img 的節點與原文出處", () => {
    const keys = graph.nodes.map((n) => n.key);
    expect(keys).toContain("onerror");
    expect(keys).toContain("img");
    const ev = graph.evidence["concept:onerror"];
    expect(ev.docs[0].docName).toBe("<b>evil</b>.html");
    const snippets = buildSnippets(ev, docs);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0].before + snippets[0].match + snippets[0].after).toContain(`<img src=x onerror="window.__HYPERFORGE_XSS__=1">`);
  });

  // 每個 payload 由它自己的節點顯示（片段只含命中詞前後各 60 字）
  const CASES: Array<[string, string]> = [
    ["onerror", `<img src=x onerror="window.__HYPERFORGE_XSS__=1">`],
    ["script", `<script>window.__HYPERFORGE_XSS__=2</script>`],
    ["onload", `<svg onload="window.__HYPERFORGE_XSS__=3"></svg>`],
  ];

  it.each(CASES)("SourcePanel 渲染 %s 節點：字面文字被跳脫，輸出的 HTML 中沒有 img / script / svg 元素", (key, literal) => {
    const node = graph.nodes.find((n) => n.key === key)!;
    expect(node, `fixture 應產生 ${key} 節點`).toBeDefined();
    const html = renderToStaticMarkup(createElement(SourcePanel, { node, evidence: graph.evidence[node.id], docs, selectedCount: 1 }));
    // 使用者實際看到的文字，就是 fixture 的字面內容（命中詞被 <mark> 包住，所以先去除真正的標籤再比對）
    expect(visibleText(html)).toContain(literal);
    // 原始 HTML 中，使用者內容的 < > " 都被跳脫成 entity（命中詞被 <mark> 包住，所以不比對完整的 entity 字串）
    expect(html).toContain("&lt;");
    expect(html).toContain("&quot;");
    // 文件名稱中的 HTML 也是純文字
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;.html");
    // 沒有任何會執行或載入的元素，也沒有行內事件處理屬性
    expect(html).not.toMatch(/<\s*(img|script|svg|iframe|object|embed|style)\b/i);
    expect(html).not.toMatch(/<b>evil/);
    // 真正的標籤內不得有事件處理屬性（逸出後的文字不含真正的 <，所以這個樣式只會比對到真正的標籤）
    expect(html).not.toMatch(/<[a-z][^>]*\son(error|load|click)\s*=/i);
  });

  it("暫存節點的使用者自訂名稱含 HTML 時，同樣只是純文字", () => {
    const [a, b] = graph.nodes.filter((n) => n.kind === "concept").slice(0, 2);
    const hostileName = `<img src=x onerror=alert(1)>`; // 28 字，未超過名稱長度上限
    const temp = makeAlchemyNode([a, b], hostileName)!;
    expect(temp.label).toBe(hostileName);
    const html = renderToStaticMarkup(
      createElement(SourcePanel, { node: temp, docs, selectedCount: 1, parentLabels: [a.label, b.label] }),
    );
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(visibleText(html)).toContain(hostileName);
    expect(html).not.toMatch(/<\s*img\b/i);
  });

  it("Canvas 標籤不經過 HTML：truncateLabel 原樣保留字元（由 fillText 繪製）", () => {
    expect(truncateLabel(`<img src=x onerror=1>`, 100)).toBe(`<img src=x onerror=1>`);
  });

  it("測試環境確實沒有被執行的 payload：window.__HYPERFORGE_XSS__ 未被設定", () => {
    expect((globalThis as Record<string, unknown>).__HYPERFORGE_XSS__).toBeUndefined();
  });
});

describe("原始碼掃描：禁止會把字串當 HTML 解析的 API", () => {
  const files = [...sourceFiles(join(ROOT, "components")), ...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app"))];
  const BANNED = /dangerouslySetInnerHTML|\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write\b|createContextualFragment|\beval\s*\(|new Function\s*\(|DOMParser/;

  it("掃描到足夠多的原始檔（避免路徑錯誤造成空掃描）", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("SourcePanel.tsx"))).toBe(true);
  });

  it("components / lib / app 的非測試原始碼不使用 innerHTML、dangerouslySetInnerHTML 等", () => {
    const hits = files.filter((f) => BANNED.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "")));
    expect(hits.map((f) => norm(f).replace(norm(ROOT), ""))).toEqual([]);
  });
});
