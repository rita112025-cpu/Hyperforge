import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest } from "./digest";
import { escapeMarkdown, unescapeMarkdown } from "./markdown";
import { buildNotionExport } from "./notion";
import { buildSummary, summaryToMarkdown } from "./summary";

function doc(name: string, text: string): GraphDocument {
  return { id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) };
}

/** 未跳脫的出現：前面不是奇數個反斜線 */
const unescapedIndex = (md: string, needle: string): number => {
  for (let i = md.indexOf(needle); i >= 0; i = md.indexOf(needle, i + 1)) {
    let bs = 0;
    for (let j = i - 1; j >= 0 && md[j] === "\\"; j--) bs++;
    if (bs % 2 === 0) return i;
  }
  return -1;
};

const HOSTILE = [
  "![track](http://evil.example/p.png) cable tray conduit routing clearance panel.",
  "[click me](javascript:alert(1)) cable tray conduit routing clearance panel needs review.",
  "<script>alert(2)</script> cable tray conduit routing clearance panel stays <b>bold</b> today.",
  "# Heading cable tray conduit routing clearance panel is checked every round.",
  "- cable tray conduit routing clearance panel list item with www.evil.example and https://evil.example/x.",
  "1. cable tray conduit routing clearance panel numbered item mail me at a@evil.example now.",
  "> cable tray conduit routing clearance panel quote &lt;b&gt; table | cell | here ~~strike~~ done.",
];

describe("escapeMarkdown", () => {
  it("危險片段被跳脫：圖片、連結、HTML、標題、清單、引用、編號、自動連結、email", () => {
    for (const bad of ["![x](http://a)", "[x](javascript:alert(1))", "<script>", "<img src=x onerror=1>", "# h", "- item", "+ item", "> q", "1. item", "http://e.com", "www.e.com", "javascript:alert(1)", "a@b.com", "&lt;", "a | b", "~~x~~", "`code`", "**b**", "_i_"]) {
      const out = escapeMarkdown(bad);
      expect(unescapedIndex(out, "!["), bad).toBe(-1);
      expect(unescapedIndex(out, "]("), bad).toBe(-1);
      expect(unescapedIndex(out, "<"), bad).toBe(-1);
      expect(unescapedIndex(out, "`"), bad).toBe(-1);
      expect(/^(\s*)[#>]/.test(out) || /^[-+]\s/.test(out) || /^\d+\.\s/.test(out), bad).toBe(false);
      expect(unescapedIndex(out, "://"), bad).toBe(-1);
      expect(unescapedIndex(out, "javascript:"), bad).toBe(-1);
    }
  });

  it("還原跳脫後等於原句（顯示結果不變）", () => {
    for (const s of HOSTILE) expect(unescapeMarkdown(escapeMarkdown(s))).toBe(s);
    expect(unescapeMarkdown(escapeMarkdown("a\\b \\\\ c\\*"))).toBe("a\\b \\\\ c\\*");
  });

  it("對隨機 ASCII 標點與中英文混合字串：還原後相同（固定 seed fuzz）", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const alphabet = "\\`*_[]()<>!#|~&@{}-+.:/ \n0123456789abcXYZ電纜槽，。：";
    for (let n = 0; n < 500; n++) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 30) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
      expect(unescapeMarkdown(escapeMarkdown(s)), JSON.stringify(s)).toBe(s);
    }
  });

  it("一般中文與英文句子幾乎不變（沒有標點時完全不變）", () => {
    expect(escapeMarkdown("電纜槽與通信線纜架需要保持淨距，避免訊號干擾。")).toBe("電纜槽與通信線纜架需要保持淨距，避免訊號干擾。");
    expect(escapeMarkdown("Cable tray routing must keep clearance")).toBe("Cable tray routing must keep clearance");
  });

  it("行首的清單、編號與引用：只跳脫行首（含換行後的行首）", () => {
    expect(escapeMarkdown("- a")).toBe("\\- a");
    expect(escapeMarkdown("x\n- a\n1. b\n> c")).toBe("x\n\\- a\n1\\. b\n\\> c");
    expect(escapeMarkdown("3.14 is pi")).toBe("3.14 is pi"); // 小數不是編號
  });
});

describe("summaryToMarkdown 對 hostile 原文與文件名", () => {
  const docs = [doc("report](http://evil.example).md", HOSTILE.join("\n")), doc("<img src=x onerror=1>.md", HOSTILE.join("\n") + "\ncable tray conduit routing clearance panel once more here today.")];
  const graph = buildGraph(docs);
  const md = summaryToMarkdown(buildSummary(buildDigest(docs, graph)));

  it("fixture 確實進入輸出（避免空轉）", () => {
    expect(graph.nodes.length).toBeGreaterThan(3);
    expect(md).toContain("## 三行摘要");
    expect(md.length).toBeGreaterThan(200);
  });

  it("輸出中沒有未跳脫的 ![、](、<script、<img、javascript:、http://、行首標題", () => {
    for (const needle of ["![", "](", "<script", "<img", "<b>", "javascript:", "://"]) expect(unescapedIndex(md, needle), needle).toBe(-1);
    // 內容行（不含我們自己的標題與引用框架）不得以 # 開頭
    const ours = new Set(["# 核心摘要", "## 三行摘要", "## 十個重點", "## 說明"]);
    for (const line of md.split("\n")) if (/^#/.test(line)) expect(ours.has(line), line).toBe(true);
  });

  it("每個內容行都以我們的框架（編號或「- 」）開頭，而不是使用者內容", () => {
    const body = md.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith(">"));
    for (const l of body) expect(/^(\d+\. |- )/.test(l), l).toBe(true);
  });

  it("還原跳脫後，每個使用者句子仍完整出現在輸出中（引文沒有被改寫）", () => {
    const restored = unescapeMarkdown(md);
    const digest = buildDigest(docs, graph);
    const first = buildSummary(digest).lines[0].segments.find((s) => s.kind === "quote")!;
    expect(restored).toContain(first.text);
  });
});

describe("Notion：pages 帶有 parent 占位符，使用流程是兩步", () => {
  it("每頁 parent = {type:'database_id', database_id:'<建立資料庫後填入>'}；note 說明先建立資料庫再填入", () => {
    const docs = [doc("a.md", HOSTILE.join("\n")), doc("b.md", HOSTILE.join("\n") + "\ncable tray conduit routing clearance panel once more here today.")];
    const n = buildNotionExport(buildDigest(docs, buildGraph(docs)));
    expect(n.pages.length).toBeGreaterThan(0);
    for (const p of n.pages) expect(p.parent).toEqual({ type: "database_id", database_id: "<建立資料庫後填入>" });
    expect(n.database.parent.page_id).toContain("請填入");
    expect(n.note).toContain("先用 database 建立資料庫");
    expect(n.note).toContain("每個 page 的 parent");
    expect(n.note).toContain("未驗證");
  });
});

describe("setext 標題底線（只由 = 組成的行）", () => {
  it("行首只由 = 組成的行會被跳脫，還原後等於原文", () => {
    for (const s of ["title\n===", "title\n=====\nnext", "===", "a\n= = =\nb"]) {
      const out = escapeMarkdown(s);
      expect(unescapeMarkdown(out), s).toBe(s);
      for (const line of out.split("\n")) expect(/^=+\s*$/.test(line), JSON.stringify(line)).toBe(false);
    }
  });
  it("一般含 = 的句子不受影響", () => {
    expect(escapeMarkdown("a = b")).toBe("a = b");
    expect(escapeMarkdown("x==y")).toBe("x==y");
  });
});
