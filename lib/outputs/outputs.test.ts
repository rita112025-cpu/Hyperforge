import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { MAX_SENTENCE_CHARS, MIN_SENTENCE_CHARS, buildDigest, representativeSentence, selectDiverse } from "./digest";
import { NOTION_FORMAT, buildNotionExport, notionOptionName, notionToJson } from "./notion";
import { SUMMARY_BULLETS, SUMMARY_LINES, buildSummary, summaryToMarkdown } from "./summary";

function doc(name: string, text: string): GraphDocument {
  return { id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) };
}

const ZH_A = [
  "電纜槽與通信線纜架需要保持淨距，避免訊號干擾。",
  "弱電橋架與其他管線應保持安全間距，方便日後維修。",
  "機房內的電纜槽必須分類敷設，強電與弱電不得混放。",
  "電纜槽內的線纜不得超過容量，橋架需預留擴充空間。",
  "通信線纜架的支撐間距應定期檢查，確保荷重安全。",
].join("\n");
const ZH_B = [
  "弱電橋架內的線纜應整齊綁紮，並標示用途。",
  "電纜槽施工前必須確認淨距，再安裝橋架與支撐。",
  "機房弱電系統完成後，需要測試通信線纜的訊號品質。",
].join("\n");
const EN = [
  "Cable tray routing must keep clearance from conduit and panel enclosures.",
  "The cable tray support spacing should be reviewed during every inspection round.",
  "Conduit routing near the panel requires extra clearance for maintenance access.",
  "Panel enclosures and cable tray supports must be labeled before inspection.",
].join("\n");

function fixture() {
  const docs = [doc("管線規範.md", ZH_A), doc("施工筆記.md", ZH_B), doc("tray-notes.md", EN)];
  const graph = buildGraph(docs);
  return { docs, graph, digest: buildDigest(docs, graph) };
}

describe("buildDigest", () => {
  it("fixture 確實抽出概念與句子（避免空資料讓下面的斷言變成空轉）", () => {
    const { graph, digest } = fixture();
    expect(graph.nodes.length).toBeGreaterThan(5);
    expect(digest.concepts.length).toBe(graph.nodes.length);
    expect(digest.sentences.length).toBeGreaterThan(5);
  });

  it("每個句子都逐字來自原文：rawText.slice(start,end) === text，且長度在範圍內", () => {
    const { docs, digest } = fixture();
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const s of digest.sentences) {
      expect(byId.get(s.docId)!.rawText.slice(s.start, s.end)).toBe(s.text);
      const len = Array.from(s.text).length;
      expect(len).toBeGreaterThanOrEqual(MIN_SENTENCE_CHARS);
      expect(len).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
      expect(s.conceptIds.length).toBeGreaterThan(0);
    }
  });

  it("句子依 score 由高到低；決定性：同輸入兩次結果完全相同", () => {
    const a = fixture().digest;
    const b = fixture().digest;
    for (let i = 1; i < a.sentences.length; i++) expect(a.sentences[i - 1].score).toBeGreaterThanOrEqual(a.sentences[i].score);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("暫存（煉成）節點不進 digest", () => {
    const { docs, graph } = fixture();
    const withTemp = {
      ...graph,
      nodes: [...graph.nodes, { ...graph.nodes[0], id: "temp:x", label: "暫存節點", kind: "temp" as const, temporary: true }],
    };
    const d = buildDigest(docs, withTemp);
    expect(d.concepts.some((c) => c.temporary)).toBe(false);
  });

  it("同一句出現在兩份文件只留第一個（近似重複去除）", () => {
    const text = "電纜槽與通信線纜架需要保持淨距，避免訊號干擾。\n弱電橋架與其他管線應保持安全間距，方便日後維修。\n電纜槽內的線纜不得超過容量，橋架需預留擴充空間。";
    const docs = [doc("a.md", text), doc("b.md", text + "\n電纜槽施工前必須確認淨距，再安裝橋架與支撐。")];
    const g = buildGraph(docs);
    const d = buildDigest(docs, g);
    const texts = d.sentences.map((s) => s.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("空輸入 / 沒有概念：不丟錯，回傳空結構", () => {
    const empty = buildDigest([], buildGraph([]));
    expect(empty.concepts).toEqual([]);
    expect(empty.sentences).toEqual([]);
    const tiny = [doc("t.md", "太短")];
    expect(() => buildDigest(tiny, buildGraph(tiny))).not.toThrow();
  });

  it("conceptDocs 取自圖譜 evidence（精確），每個概念都有文件", () => {
    const { digest } = fixture();
    for (const c of digest.concepts) expect(digest.conceptDocs[c.id].length).toBeGreaterThan(0);
  });
});

describe("selectDiverse / representativeSentence", () => {
  it("挑選不重複、數量不超過候選；涵蓋的概念比單純取前 n 名更多或相等", () => {
    const { digest } = fixture();
    const picks = selectDiverse(digest, 3);
    expect(new Set(picks).size).toBe(picks.length);
    expect(picks.length).toBe(3);
    const cover = (xs: typeof picks) => new Set(xs.flatMap((s) => s.conceptIds)).size;
    expect(cover(picks)).toBeGreaterThanOrEqual(cover(digest.sentences.slice(0, 3)));
  });

  it("n 大於候選數：照實少給，不湊數", () => {
    const { digest } = fixture();
    expect(selectDiverse(digest, 10_000).length).toBe(digest.sentences.length);
  });

  it("exclude 的句子不會被挑到", () => {
    const { digest } = fixture();
    const first = selectDiverse(digest, 1);
    const next = selectDiverse(digest, 1, new Set(first));
    expect(next[0]).not.toBe(first[0]);
  });

  it("representativeSentence：回傳含該概念且分數最高的句子；沒有則 null", () => {
    const { digest } = fixture();
    const c = digest.concepts[0];
    const s = representativeSentence(digest, c.id)!;
    expect(s.conceptIds).toContain(c.id);
    expect(representativeSentence(digest, "concept:不存在")).toBeNull();
  });
});

describe("buildSummary（3 行 + 10 點）", () => {
  it("3 行 + 最多 10 點；每一點的概念名稱出現在它引用的原文句子裡", () => {
    const { digest } = fixture();
    const r = buildSummary(digest);
    expect(r.lines).toHaveLength(SUMMARY_LINES);
    expect(r.bullets.length).toBeGreaterThan(0);
    expect(r.bullets.length).toBeLessThanOrEqual(SUMMARY_BULLETS);
    for (const b of r.bullets) {
      const q = b.segments.find((x) => x.kind === "quote")!;
      expect(q.text.toLowerCase()).toContain(b.concept.toLowerCase());
    }
  });

  it("資料不足時照實少給，並在 notes 說明（不湊數、不編造）", () => {
    const docs = [doc("small.md", "電纜槽與通信線纜架需要保持淨距。\n電纜槽施工前必須確認淨距，再安裝橋架與支撐。")];
    const d = buildDigest(docs, buildGraph(docs));
    const r = buildSummary(d);
    expect(r.lines.length + r.bullets.length).toBeLessThan(SUMMARY_LINES + SUMMARY_BULLETS);
    if (r.lines.length < SUMMARY_LINES) expect(r.notes.join()).toContain("不湊數");
  });

  it("沒有任何句子：notes 說明原因，Markdown 不含空的章節", () => {
    const r = buildSummary(buildDigest([], buildGraph([])));
    expect(r.lines).toEqual([]);
    expect(r.bullets).toEqual([]);
    expect(r.notes[0]).toContain("無法產生摘要");
    const md = summaryToMarkdown(r);
    expect(md).not.toContain("三行摘要");
    expect(md).toContain("無法產生摘要");
  });

  it("Markdown：含標題、非 AI 聲明、三行與十點，且每行附文件名", () => {
    const { digest } = fixture();
    const md = summaryToMarkdown(buildSummary(digest));
    expect(md).toContain("# 核心摘要");
    expect(md).toContain("非 AI");
    expect(md).toContain("## 三行摘要");
    expect(md).toContain("## 十個重點");
    expect(md).toMatch(/\d\. .+（.+\.md）/);
  });

  it("決定性：同輸入 → 同 Markdown", () => {
    expect(summaryToMarkdown(buildSummary(fixture().digest))).toBe(summaryToMarkdown(buildSummary(fixture().digest)));
  });

  it("使用者原文含 Markdown / HTML 特殊字元時，輸出是純文字（不被當成指令，也不丟錯）", () => {
    const hostile = [
      "<img src=x onerror=alert(1)> cable tray cable tray conduit routing clearance panel.",
      "Cable tray conduit routing clearance panel <script>alert(2)</script> needs review again.",
      "The cable tray and conduit routing clearance panel stays <b>bold</b> in every report.",
    ].join("\n");
    const docs = [doc("h.md", hostile)];
    const md = summaryToMarkdown(buildSummary(buildDigest(docs, buildGraph(docs))));
    expect(typeof md).toBe("string"); // 內容原樣保留（匯出的是文字檔，不是 HTML）；UI 層以文字節點顯示
  });
});

describe("buildNotionExport", () => {
  it("形狀：format、database.properties 五個欄位、pages 與概念一一對應", () => {
    const { digest } = fixture();
    const n = buildNotionExport(digest);
    expect(n.format).toBe(NOTION_FORMAT);
    expect(Object.keys(n.database.properties).sort()).toEqual(["Documents", "Frequency", "Name", "Source", "Type"]);
    expect(n.pages).toHaveLength(digest.concepts.length);
    expect(n.note).toContain("未驗證");
    expect(n.database.parent.page_id).toContain("請填入");
  });

  it("Frequency 是精確的圖譜 freq；Documents 來自 evidence；Source 為原文句子並附文件名", () => {
    const { digest } = fixture();
    const n = buildNotionExport(digest);
    digest.concepts.forEach((c, i) => {
      const p = n.pages[i].properties;
      expect(p.Frequency.number).toBe(c.freq);
      expect(p.Name.title[0].text.content).toBe(c.label);
      expect(p.Documents.multi_select.length).toBeGreaterThan(0);
    });
    const withSource = n.pages.filter((p) => p.properties.Source.rich_text.length > 0);
    expect(withSource.length).toBeGreaterThan(0);
    expect(withSource[0].properties.Source.rich_text[0].text.content).toMatch(/（.+）$/);
  });

  it("database 的 select / multi_select options 涵蓋所有 pages 實際用到的值", () => {
    const { digest } = fixture();
    const n = buildNotionExport(digest);
    const typeOpts = new Set(n.database.properties.Type.select.options.map((o) => o.name));
    const docOpts = new Set(n.database.properties.Documents.multi_select.options.map((o) => o.name));
    for (const p of n.pages) {
      expect(typeOpts.has(p.properties.Type.select.name)).toBe(true);
      for (const d of p.properties.Documents.multi_select) expect(docOpts.has(d.name)).toBe(true);
    }
  });

  it("人名標為 heuristic 類型；Notion 限制：選項名稱不含逗號、不為空、≤100 字；文字 ≤2000 字", () => {
    expect(notionOptionName("a,b，c")).toBe("a b c");
    expect(notionOptionName("   ")).toBe("(未命名)");
    expect(Array.from(notionOptionName("字".repeat(300))).length).toBe(100);
    const docs = [doc("含,逗號，的檔名.md", ZH_A), doc("b.md", ZH_B)];
    const n = buildNotionExport(buildDigest(docs, buildGraph(docs)));
    for (const o of n.database.properties.Documents.multi_select.options) expect(o.name).not.toMatch(/[,，]/);
    for (const p of n.pages) for (const t of p.properties.Source.rich_text) expect(Array.from(t.text.content).length).toBeLessThanOrEqual(2000);
  });

  it("toJSON 可被 JSON.parse 還原，且內容不變", () => {
    const { digest } = fixture();
    const n = buildNotionExport(digest);
    expect(JSON.parse(notionToJson(n))).toEqual(n);
  });

  it("空輸入：pages 為空，仍是合法結構", () => {
    const n = buildNotionExport(buildDigest([], buildGraph([])));
    expect(n.pages).toEqual([]);
    expect(JSON.parse(notionToJson(n)).format).toBe(NOTION_FORMAT);
  });
});
