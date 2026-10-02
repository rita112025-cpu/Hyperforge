import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import OutputsPanel from "../../components/OutputsPanel";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";

function doc(name: string, text: string): GraphDocument {
  return { id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) };
}

// 同 security.test.ts 的 hostile fixture 思路：原文與文件名都含 HTML / script / 事件屬性。
const HOSTILE = [
  '<img src=x onerror="alert(1)"> Cable tray routing must keep clearance from the conduit panel.',
  "Conduit routing near the panel requires clearance <script>alert(2)</script> and review.",
  'The cable tray and conduit panel labels are "checked" <b onmouseover=alert(3)>bold</b> every round.',
  "Cable tray support spacing near the conduit panel is reviewed; <iframe src=javascript:alert(4)></iframe> ignored.",
].join("\n");

describe("OutputsPanel 對 hostile 內容：全部顯示為純文字", () => {
  const docs = [doc('<img src=x onerror=alert(9)>.md', HOSTILE), doc("<script>x</script>b.md", HOSTILE + "\nCable tray panel conduit routing clearance again and again.")];
  const graph = buildGraph(docs);
  const html = renderToStaticMarkup(<OutputsPanel docs={docs} graph={graph} />);

  it("fixture 確實進入輸出（避免空轉）", () => {
    expect(graph.nodes.length).toBeGreaterThan(3);
    expect(html).toContain("data-testid=\"summary-lines\"");
    expect(html).toContain("&lt;img src=x onerror=");
  });

  it("輸出的 HTML 中沒有任何來自使用者內容的真正標籤或事件屬性", () => {
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/<b\s+onmouseover/i);
    // 真正的事件屬性會出現在「標籤內」：<tag ... onxxx=。使用者內容被跳脫後只會是 &lt;img ... 這種文字，不會形成標籤
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("Notion 預覽（<pre>）也是跳脫後的文字", () => {
    const withNotion = renderToStaticMarkup(<OutputsPanel docs={docs} graph={graph} />);
    expect(withNotion).not.toMatch(/<pre[^>]*>[^<]*<img/i);
  });

  it("空圖譜：顯示明確的空狀態，沒有輸出內容", () => {
    const empty = renderToStaticMarkup(<OutputsPanel docs={[]} graph={buildGraph([])} />);
    expect(empty).toContain("outputs-empty");
    expect(empty).not.toContain("summary-lines");
  });

  it("資料基礎一定顯示文件數與概念數", () => {
    expect(html).toContain("outputs-basis");
    expect(html).toMatch(/基於 2 份文件/);
  });
});
