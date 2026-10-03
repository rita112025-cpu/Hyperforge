import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SocraticView } from "../../components/OutputViews";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest } from "./digest";
import { verifySegments, type Segment } from "./segments";
import { EXCLUDED_PHRASES, QUESTION_TABLE, buildSocratic, findCues, questionsFor, socraticLines } from "./socratic";

const doc = (name: string, text: string): GraphDocument => ({ id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) });
const cues = (t: string) => findCues(t).map((c) => c.cue);

describe("否定與緩和語境不算強斷言", () => {
  it("中文：並非所有、不是唯一、未必、不一定、不見得、並不一定", () => {
    for (const t of ["並非所有線纜都需要分類", "這不是唯一的方法", "弱電未必需要保持淨距", "電纜槽不一定必須加蓋", "這不見得所有情況都成立", "並不是所有橋架都適用"]) expect(cues(t), t).toEqual([]);
  });
  it("英文：not all、isn't the only、not only … but also、never 前的 not", () => {
    for (const t of ["Not all cables must be labeled", "This isn't the only option available", "It is not only fast but also cheap", "We do not always inspect every tray"]) expect(findCues(t).map((c) => c.cue), t).not.toContain("only");
    expect(cues("Not all cables need labels")).toEqual([]);
    expect(cues("This isn't the only option")).toEqual([]);
    expect(cues("It is not only fast but also cheap")).toEqual([]);
  });
  it("肯定語境照常算：所有線纜都必須分類、Cables must be labeled", () => {
    expect(cues("所有線纜都必須分類")).toEqual(["所有", "必須"]);
    expect(cues("Cables must be labeled")).toEqual(["must"]);
  });
  it("視窗只看線索之前 6 個字元：很遠的否定不影響", () => {
    expect(cues("這個系統並不複雜，但是在施工階段所有線纜都要先確認")).toContain("所有");
  });
});

describe("專有詞組不是斷言", () => {
  it("清單鎖住：不可燃、不可見、所有權、所有人、所有格、唯一識別碼、全部門、不得已 都不觸發", () => {
    for (const p of EXCLUDED_PHRASES) expect(cues(`這份文件提到${p}的相關說明`), p).toEqual([]);
    expect(cues("不可燃材料應存放於獨立區域")).toEqual([]);
    expect(cues("設備的所有權屬於業主")).toEqual([]);
    expect(cues("每個資產有唯一識別碼")).toEqual([]);
    expect(cues("全部門的人員皆可查閱")).toEqual([]);
  });
  it("專有詞組之外的線索仍會被找出", () => {
    expect(cues("不可燃材料必須存放於獨立區域")).toEqual(["必須"]);
    expect(cues("所有人都必須簽名")).toEqual(["必須"]);
  });
});

describe("英文 \b 邊界與縮寫", () => {
  it("allowed / nevertheless / overall / metallic / shallow / calls 不觸發", () => {
    for (const t of ["Access is allowed", "Nevertheless it works", "Overall it was fine", "metallic tray", "shallow depth", "recall and fallback", "allocate resources"]) expect(findCues(t), t).toEqual([]);
  });
  it("cannot 要算；shall not 要算；can't 不算（縮寫否定本身不是全稱或必要，已決定並寫明）", () => {
    expect(cues("Cables cannot be mixed")).toEqual(["cannot"]);
    expect(cues("Cables shall not be mixed")).toEqual(["shall not"]);
    expect(cues("Cables can't be mixed")).toEqual([]);
    expect(cues("Cables must be labeled and all trays are checked").sort()).toEqual(["all", "must"]);
  });
});

describe("問句對應表與白名單", () => {
  it("表格寫死；每列最多兩個問句；所有問句都在白名單內", () => {
    expect(QUESTION_TABLE).toEqual({ universal: ["這個說法有例外嗎？", "依據是什麼？"], exclusive: ["有沒有其他情況？"], necessity: ["依據是什麼？"] });
    for (const qs of Object.values(QUESTION_TABLE)) expect(qs.length).toBeLessThanOrEqual(2);
    for (const t of ["所有線纜", "只有一個", "必須分類", "所有線纜只有一個必須"]) expect(questionsFor(findCues(t)).length).toBeLessThanOrEqual(2);
  });

  const F = (() => {
    const text = [
      "電纜槽與通信線纜架必須保持淨距，避免訊號干擾，並且定期檢查。",
      "所有弱電橋架與其他管線應保持安全間距，方便日後維修與檢查。",
      "機房內只有強電線纜可以進入電纜槽，弱電不得混放，並且分類。",
      "電纜槽內的線纜不得超過容量，橋架需預留擴充空間與通風散熱。",
    ].join(String.fromCharCode(10));
    const docs = [doc("a.md", text), doc("b.md", text + String.fromCharCode(10) + "弱電橋架內的線纜必須整齊綁紮，並標示用途與日期標籤。")];
    return { docs, d: buildDigest(docs, buildGraph(docs)), src: new Map(docs.map((x) => [x.id, { name: x.name, rawText: x.rawText }])) };
  })();

  it("負向測試：塞進「這顯然是錯的」之類的 frame 會被 verifySegments 抓到", () => {
    const r = buildSocratic(F.d);
    expect(r.items.length).toBeGreaterThan(0);
    for (const line of socraticLines(r)) expect(verifySegments(line, F.src)).toEqual([]);
    const tampered: Segment[] = [...r.items[0].lines[0], { kind: "frame", text: "這顯然是錯的" }];
    expect(verifySegments(tampered, F.src).join()).toContain("白名單");
    const stitched: Segment[] = [{ kind: "frame", text: "  - " }, { kind: "frame", text: "這個說法有例外嗎？依據是什麼？" }]; // 拼接成新句子也不行
    expect(verifySegments(stitched, F.src).join()).toContain("白名單");
  });

  it("同一個原句不會出現兩次；每個項目只用表格裡的問句", () => {
    const r = buildSocratic(F.d);
    const keys = r.items.map((i) => `${i.sentence.docId}:${i.sentence.start}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const it of r.items) expect(it.lines.length - 1).toBeLessThanOrEqual(2);
  });

  it("UI：說明規範條文的處理（必須／不得／禁止是條文用語），且仍標示規則式、非論證", () => {
    const html = renderToStaticMarkup(<SocraticView result={buildSocratic(F.d)} />);
    expect(html).toContain("請對照出處");
    expect(html).toContain("條文");
    expect(html).toContain("非論證");
    expect(html).not.toContain("最強反駁");
  });
});

describe("含「不／未／無」的非否定詞不會抑制真正的強斷言", () => {
  it("不同廠牌的設備必須…、未來新增設備必須…、無線設備必須…、無論如何都必須… 仍抓到「必須」", () => {
    for (const t of ["不同廠牌的設備必須分開存放", "未來新增設備必須先經過審核", "無線設備必須定期檢查訊號", "無論如何施工前都必須確認淨距"]) expect(cues(t), t).toContain("必須");
  });
  it("真正的否定仍然抑制：並非所有（視窗只看線索前 6 個字元，所以其後較遠的「必須」仍算）", () => {
    expect(cues("這並非所有設備都需要檢查")).toEqual([]);
    expect(cues("這並非所有設備都必須")).not.toContain("所有");
  });
});
