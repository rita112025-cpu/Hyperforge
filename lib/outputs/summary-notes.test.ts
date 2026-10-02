import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/build";
import { chunkText } from "../pipeline/chunker";
import { buildDigest } from "./digest";
import { buildSummary, summaryToMarkdown } from "./summary";

function doc(name: string, text: string) {
  return { id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) };
}

describe("有概念但沒有可用句子：說明原因，而不是誤導成「內容太短」", () => {
  // 沒有任何標點 / 換行的長段落：概念會達到門檻，但整段遠超過句子長度上限
  const long = Array.from({ length: 400 }, (_, i) => ["cable", "tray", "conduit", "routing"][i % 4] + (i % 9)).join(" ");

  it("fixture：確實有概念、確實沒有句子", () => {
    const docs = [doc("long.txt", long)];
    const d = buildDigest(docs, buildGraph(docs));
    expect(d.concepts.length).toBeGreaterThan(0);
    expect(d.sentences.length).toBe(0);
  });

  it("note 明說有 N 個概念、句子長度範圍、可能原因；仍標明無法產生摘要", () => {
    const docs = [doc("long.txt", long)];
    const d = buildDigest(docs, buildGraph(docs));
    const r = buildSummary(d);
    expect(r.lines).toEqual([]);
    expect(r.bullets).toEqual([]);
    expect(r.notes[0]).toContain(`${d.concepts.length} 個概念`);
    expect(r.notes[0]).toContain("12–140");
    expect(r.notes[0]).toContain("沒有標點");
    expect(r.notes[0]).toContain("無法產生摘要");
    expect(r.notes[0]).not.toContain("內容太短");
    expect(summaryToMarkdown(r)).toContain("無法產生摘要");
  });
});
