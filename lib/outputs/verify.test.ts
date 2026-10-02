import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest, describeBasis } from "./digest";
import { safeFilename } from "./export";
import {
  EMPTY_OPTION_NAME,
  MULTI_SELECT_MAX,
  NOTION_SOURCES,
  OPTION_NAME_MAX,
  OptionRegistry,
  RICH_TEXT_MAX,
  buildNotionExport,
  notionOptionName,
  richText,
  splitText,
} from "./notion";
import { FRAME_WHITELIST, isAllowedFrame, segmentsToText, verifySegments, type Segment, type SourceDoc } from "./segments";
import { buildSummary, summarySegments } from "./summary";

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
const docsOf = (docs: GraphDocument[]): Map<string, SourceDoc> => new Map(docs.map((d) => [d.id, { name: d.name, rawText: d.rawText }]));
const fixtureDocs = () => [doc("管線規範.md", ZH_A), doc("施工筆記.md", ZH_B), doc("tray-notes.md", EN)];

describe("片段檢查：quote 逐字等於原文切片、frame 全在白名單內（對每一個摘要項目）", () => {
  const docs = fixtureDocs();
  const digest = buildDigest(docs, buildGraph(docs));
  const summary = buildSummary(digest);
  const items = summarySegments(summary);

  it("fixture 有 3 行與足夠的 bullet（避免空轉）", () => {
    expect(summary.lines).toHaveLength(3);
    expect(summary.bullets.length).toBeGreaterThanOrEqual(5);
  });

  it("(i) 所有 quote 片段 text === rawText.slice(start,end)；(ii) 所有 frame 都在白名單；ref 等於文件名；term 出現在引用的原文", () => {
    for (const item of items) expect(verifySegments(item, docsOf(docs))).toEqual([]);
  });

  it("每個項目至少含一個 quote（內容一定來自原文），且 frame 只是標號 / 標點 / 括號", () => {
    for (const item of items) {
      expect(item.some((s) => s.kind === "quote")).toBe(true);
      for (const s of item) if (s.kind === "frame") expect(isAllowedFrame(s.text)).toBe(true);
    }
  });

  it("白名單本身不含任何對內容的判斷詞（人工維護的守門：新增框架時這裡要一起更新並過審）", () => {
    const judgement = /(其實|多數|大家|都搞錯|你以為|真相|必須|一定|絕對|最|永遠|從來)/;
    for (const f of FRAME_WHITELIST) expect(f, f).not.toMatch(judgement);
  });

  it("負向測試：檢查器真的會抓到違規（不是空轉）", () => {
    const d = docsOf(docs);
    const q = items[0].find((s) => s.kind === "quote") as Extract<Segment, { kind: "quote" }>;
    const bad = (extra: Segment[]) => verifySegments([...items[0], ...extra], d);
    expect(bad([{ kind: "frame", text: "多數人都搞錯了" }]).join()).toContain("白名單");
    expect(verifySegments([{ ...q, text: q.text + "！" }], d).join()).toContain("切片不符");
    expect(verifySegments([{ ...q, start: q.start + 1 }], d).join()).toContain("切片不符");
    expect(verifySegments([{ kind: "ref", docId: q.docId, text: "別的檔名.md" }], d).join()).toContain("文件名稱");
    expect(verifySegments([q, { kind: "term", text: "完全不存在的詞" }], d).join()).toContain("term");
    expect(verifySegments([{ ...q, docId: "nope" }], d).join()).toContain("找不到文件");
  });

  it("編號框架只接受「數字 + 點 + 空格」", () => {
    expect(isAllowedFrame("1. ")).toBe(true);
    expect(isAllowedFrame("10. ")).toBe(true);
    expect(isAllowedFrame("1.")).toBe(false);
    expect(isAllowedFrame("第一，")).toBe(false);
  });

  it("segmentsToText：term 可包裝、其餘原樣", () => {
    const segs: Segment[] = [
      { kind: "frame", text: "- " },
      { kind: "term", text: "橋架" },
      { kind: "frame", text: "：" },
    ];
    expect(segmentsToText(segs)).toBe("- 橋架：");
    expect(segmentsToText(segs, { term: (t) => `**${t}**` })).toBe("- **橋架**：");
  });
});

describe("digest：位移、決定性、順序無關、邊界", () => {
  it("每個句子 rawText.slice(start,end) === text（含前後有空白、縮排的原文）", () => {
    const text = "   電纜槽與通信線纜架需要保持淨距，避免訊號干擾。  \n\t弱電橋架與其他管線應保持安全間距，方便日後維修。\n電纜槽內的線纜不得超過容量，橋架需預留擴充空間。   ";
    const docs = [doc("space.md", text)];
    const d = buildDigest(docs, buildGraph(docs));
    expect(d.sentences.length).toBeGreaterThan(0);
    for (const s of d.sentences) expect(text.slice(s.start, s.end)).toBe(s.text);
  });

  it("文件順序打亂後，結果完全相同（含近似重複句保留哪一份）", () => {
    const shared = "電纜槽與通信線纜架需要保持淨距，避免訊號干擾。";
    const a = doc("A.md", ZH_A);
    const b = doc("B.md", ZH_B + "\n" + shared);
    const c = doc("C.md", EN);
    const run = (docs: GraphDocument[]) => JSON.stringify(buildDigest(docs, buildGraph(docs)));
    const base = run([a, b, c]);
    expect(run([c, b, a])).toBe(base);
    expect(run([b, c, a])).toBe(base);
  });

  it("同輸入跑兩次完全相同；分數相同時次序由 docId、start 決定", () => {
    const docs = fixtureDocs();
    const x = buildDigest(docs, buildGraph(docs));
    const y = buildDigest(docs, buildGraph(docs));
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
    for (let i = 1; i < x.sentences.length; i++) {
      const p = x.sentences[i - 1];
      const q = x.sentences[i];
      if (p.score === q.score) expect([p.docId, p.start] <= [q.docId, q.start] || p.docId < q.docId || (p.docId === q.docId && p.start < q.start)).toBe(true);
    }
  });

  it("單句語料：不丟錯；摘要照實少給並說明", () => {
    const docs = [doc("one.md", "電纜槽與通信線纜架需要保持淨距，避免訊號干擾。電纜槽與通信線纜架必須分開。")];
    const d = buildDigest(docs, buildGraph(docs));
    const s = buildSummary(d);
    expect(s.lines.length).toBeLessThan(3);
    expect(s.lines.length + s.bullets.length).toBeLessThan(13);
  });

  it("空語料：空結構，basis 為 0", () => {
    const d = buildDigest([], buildGraph([]));
    expect(d.sentences).toEqual([]);
    expect(d.basis.docCount).toBe(0);
    expect(describeBasis(d.basis)).toContain("0 份文件");
  });

  it("basis：概念被 150 上限截斷時明說「共 N 個、上限 150、其餘未納入」", () => {
    const basis = { docCount: 3, conceptsShown: 150, conceptsTotal: 410, nodeCap: 150, truncated: true };
    const t = describeBasis(basis);
    expect(t).toContain("3 份文件");
    expect(t).toContain("150");
    expect(t).toContain("共 410 個");
    expect(t).toContain("其餘未納入");
    expect(describeBasis({ ...basis, truncated: false, conceptsTotal: 150 })).not.toContain("其餘未納入");
  });

  it("digest 只提到圖譜上顯示的概念（不會出現畫布看不到的概念）", () => {
    const docs = fixtureDocs();
    const g = buildGraph(docs, { maxNodes: 5 });
    const d = buildDigest(docs, g);
    const shown = new Set(g.nodes.map((n) => n.id));
    expect(d.concepts.length).toBe(5);
    for (const s of d.sentences) for (const id of s.conceptIds) expect(shown.has(id)).toBe(true);
    expect(d.basis.truncated).toBe(true);
    expect(d.basis.conceptsTotal).toBeGreaterThan(5);
  });
});

describe("Notion：sanitize、切段、去重、上限", () => {
  it("選項名稱：逗號（半形、全形）→ 空白；空名稱 → (未命名)；長度 ≤100 且不切壞字", () => {
    expect(notionOptionName("a, b，c")).toBe("a b c");
    expect(notionOptionName(" , ")).toBe(EMPTY_OPTION_NAME);
    expect(notionOptionName("")).toBe(EMPTY_OPTION_NAME);
    const long = notionOptionName("字".repeat(300));
    expect(Array.from(long).length).toBe(OPTION_NAME_MAX);
    expect(Array.from(notionOptionName("😀".repeat(150))).length).toBe(OPTION_NAME_MAX);
  });

  it("選項名稱不分大小寫唯一：重複與大小寫不同者歸併到第一個寫法", () => {
    const r = new OptionRegistry();
    expect(r.register("Report.md")).toBe("Report.md");
    expect(r.register("report.md")).toBe("Report.md");
    expect(r.register("REPORT.MD")).toBe("Report.md");
    expect(r.register("a,b")).toBe("a b");
    expect(r.register("a b")).toBe("a b");
    expect(r.names()).toEqual(["Report.md", "a b"]);
  });

  it("splitText：每段 ≤2000；串回去等於原文；不把 surrogate pair 切開；空字串回 []", () => {
    const text = "x".repeat(4500) + "😀".repeat(1500) + "字".repeat(10);
    const parts = splitText(text);
    expect(parts.every((p) => p.length <= RICH_TEXT_MAX)).toBe(true);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(p).not.toMatch(/[\ud800-\udbff]$/); // 不以落單的高位代理結尾
    expect(parts.length).toBeGreaterThan(2);
    expect(splitText("")).toEqual([]);
    expect(richText("")).toEqual([]);
    expect(richText("abc")).toEqual([{ type: "text", text: { content: "abc" } }]);
  });

  it("超長 Source：切成多段（每段 ≤2000），不截斷；文件名含逗號與大小寫重複不會造成非法選項", () => {
    const long = "電纜槽" + "與通信線纜架需要保持淨距，避免訊號干擾".repeat(120) + "。";
    const docs = [doc("a, b.md", long + "\n" + ZH_A), doc("A, B.md", ZH_B + "\n電纜槽施工前必須確認淨距，再安裝橋架與支撐。"), doc("c.md", EN)];
    const digest = buildDigest(docs, buildGraph(docs));
    const n = buildNotionExport(digest);
    for (const p of n.pages) for (const t of [...p.properties.Source.rich_text, ...p.properties.Name.title]) expect(t.text.content.length).toBeLessThanOrEqual(RICH_TEXT_MAX);
    const opts = n.database.properties.Documents.multi_select.options.map((o) => o.name);
    expect(opts.every((o) => !/[,，]/.test(o))).toBe(true);
    expect(new Set(opts.map((o) => o.toLowerCase())).size).toBe(opts.length); // 不分大小寫唯一
    const used = new Set(opts);
    for (const p of n.pages) for (const m of p.properties.Documents.multi_select) expect(used.has(m.name)).toBe(true);
  });

  it("每頁 Documents 超過 100 個時截為 100 並在 warnings 說明", () => {
    const text = ZH_A + "\n" + ZH_B;
    const docs = Array.from({ length: 105 }, (_, i) => doc(`d${String(i).padStart(3, "0")}.md`, text + `\n第${i}份補充：電纜槽與橋架需要保持淨距。`));
    const digest = buildDigest(docs, buildGraph(docs));
    // 內容相同的文件會被去重；改用 conceptDocs 直接構造，驗證上限邏輯
    const forced = { ...digest, conceptDocs: Object.fromEntries(digest.concepts.map((c) => [c.id, docs.map((d) => ({ id: d.id, name: d.name }))])) };
    const n = buildNotionExport(forced);
    expect(n.pages.every((p) => p.properties.Documents.multi_select.length <= MULTI_SELECT_MAX)).toBe(true);
    expect(n.warnings.join()).toContain(`超過 ${MULTI_SELECT_MAX}`);
  });

  it("標示：未驗證匯入、parent 占位符、限制來源與查閱日期", () => {
    const docs = fixtureDocs();
    const n = buildNotionExport(buildDigest(docs, buildGraph(docs)));
    expect(n.note).toContain("未驗證");
    expect(n.database.parent.page_id).toContain("請填入");
    expect(n.limitsSources).toEqual(NOTION_SOURCES);
    expect(NOTION_SOURCES.every((s) => s.startsWith("https://developers.notion.com/") && s.includes("2026-10-03"))).toBe(true);
  });
});

describe("下載檔名：Windows 保留名稱", () => {
  it("CON / PRN / AUX / NUL / COM1 / LPT9（不分大小寫、含副檔名形式）會被加上底線前綴", () => {
    for (const n of ["CON", "con", "Prn", "AUX", "nul", "COM1", "lpt9", "CON.txt", "nul.md"]) expect(safeFilename(n), n).toBe(`_${n}`);
    for (const n of ["console", "com10", "contact", "auxiliary.md", "管線"]) expect(safeFilename(n), n).toBe(n);
  });
});
