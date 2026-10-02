import { describe, expect, it } from "vitest";
import {
  EXTRACT_METHOD_NOTE,
  HAN_STOP_TERMS,
  MIN_DOC_UNITS,
  extractConcepts,
  splitSentences,
  type ExtractUnit,
} from "./extract";

const A = "電纜槽淨距不足，需要調整弱電橋架位置。";
const B = "弱電橋架與電纜槽之間必須保留足夠間距。";
const unit = (docId: string, text: string): ExtractUnit => ({ docId, text });
const labels = (units: ExtractUnit[]) => extractConcepts(units).concepts.map((c) => c.label);

describe("extractConcepts：中文（統計近似，非斷詞）", () => {
  it("方法聲明常數明確寫出『統計近似，非中文斷詞』", () => {
    expect(EXTRACT_METHOD_NOTE).toBe("統計近似，非中文斷詞");
  });

  it("文件 A + B：抽出 電纜槽 / 弱電 / 橋架，且全部排在最前面", () => {
    const { concepts } = extractConcepts([unit("A", A), unit("B", B)]);
    const top = concepts.slice(0, 3).map((c) => c.label).sort();
    expect(top).toEqual(["弱電", "橋架", "電纜槽"].sort());
    for (const c of concepts.slice(0, 3)) {
      expect(c.freq).toBe(2);
      expect(c.docFreq).toBe(2);
    }
  });

  it("需要 / 位置 / 之間 / 必須 / 足夠 不會成為概念（包含出現在任何 n-gram 之中）", () => {
    const out = labels([unit("A", A), unit("B", B)]);
    for (const w of ["需要", "位置", "之間", "必須", "足夠"]) {
      expect(out).not.toContain(w);
      expect(out.some((l) => l.includes(w))).toBe(false);
    }
  });

  it("不產生重疊碎片：電纜槽 不會同時產生 電纜、纜槽；橋架 不會產生 電橋", () => {
    const out = labels([unit("A", A), unit("B", B)]);
    for (const frag of ["電纜", "纜槽", "電橋", "弱電橋", "電橋架"]) expect(out).not.toContain(frag);
  });

  it("3 字詞凝聚度門檻：跨詞界碎片（槽保持）不成為概念，真正的詞（電纜槽）保留", () => {
    // 「電纜槽保持」出現 2 次，但「保持」另外在別處獨立出現 3 次 → 槽保持 凝聚度 2/5 < 0.8
    const docs = [
      "電力電纜槽保持乾燥。電纜槽保持清潔。",
      "設備應保持乾燥。管線須保持清潔。環境要保持通風。電纜槽檢查完成。",
    ];
    const keys = extractConcepts(docs.map((t, i) => unit(`d${i}`, t))).concepts.map((c) => c.key);
    expect(keys).toContain("電纜槽");
    expect(keys).toContain("保持");
    expect(keys).not.toContain("槽保持");
    expect(keys).not.toContain("電纜");
  });

  it("停用詞清單包含規格指定的詞", () => {
    for (const w of ["需要", "位置", "之間", "必須", "足夠"]) expect(HAN_STOP_TERMS).toContain(w);
  });

  it("2 字與 3 字 n-gram 都能抽出（重複出現才算）", () => {
    const text = "混凝土澆置前檢查鋼筋。混凝土強度與鋼筋間距相關。鋼筋混凝土結構需要養護。";
    const out = labels([unit("d", text)]);
    expect(out).toContain("混凝土");
    expect(out).toContain("鋼筋");
  });

  it("不把整段中英混合字串逐字滑窗：Latin 與 Han 先依 script 分開", () => {
    const text = "使用 PostgreSQL 管理資料庫。PostgreSQL 的資料庫索引很重要。資料庫備份也要做。";
    const { concepts } = extractConcepts([unit("d", text)]);
    const keys = concepts.map((c) => c.key);
    expect(keys).toContain("postgresql"); // key 為小寫
    expect(concepts.find((c) => c.key === "postgresql")?.label).toBe("PostgreSQL"); // label 保留原始大小寫
    expect(keys).toContain("資料庫");
    // 沒有任何概念同時含 Latin 與 Han 字元
    expect(keys.some((l) => /\p{Script=Latin}/u.test(l) && /\p{Script=Han}/u.test(l))).toBe(false);
  });
});

describe("extractConcepts：英文與人名 heuristic", () => {
  const en =
    "The cable tray carries low-voltage cables. A cable tray must keep clearance. " +
    "Clearance between each cable tray and the ceiling is checked by Ada Lovelace. Ada Lovelace reviews every cable tray layout.";

  it("抽出英文概念、小寫 key、排除 stopword", () => {
    const { concepts } = extractConcepts([unit("en", en)]);
    const keys = concepts.filter((c) => c.kind === "concept").map((c) => c.key);
    expect(keys).toContain("cable");
    expect(keys).toContain("tray");
    expect(keys).toContain("clearance");
    for (const sw of ["the", "and", "must", "each", "every"]) expect(keys).not.toContain(sw);
  });

  it("英文人名為 heuristic：kind=person，且其組成單字不會另外變成概念", () => {
    const { concepts } = extractConcepts([unit("en", en)]);
    const person = concepts.find((c) => c.kind === "person");
    expect(person?.label).toBe("Ada Lovelace");
    expect(person?.id).toBe("person:ada lovelace");
    const keys = concepts.filter((c) => c.kind === "concept").map((c) => c.key);
    expect(keys).not.toContain("ada");
    expect(keys).not.toContain("lovelace");
  });

  it("只出現一次的人名不成立（證據門檻）；句首虛詞不當作名字", () => {
    const text = "Alan Turing wrote the paper. The Graph Database stores nodes. The Graph Database also stores edges.";
    const { concepts } = extractConcepts([unit("d", text)]);
    expect(concepts.some((c) => c.kind === "person" && c.label === "Alan Turing")).toBe(false);
    expect(concepts.some((c) => c.kind === "person" && c.label.startsWith("The "))).toBe(false);
  });

  it("中文人名不被偵測（本輪不支援）", () => {
    const text = "王小明負責設計。王小明也負責測試。王小明提交了報告。";
    const { concepts } = extractConcepts([unit("d", text)]);
    expect(concepts.every((c) => c.kind !== "person")).toBe(true);
  });

  it("Dr. / Mr. 稱謂 + 姓 視為人名候選", () => {
    const text = "Dr. Smith reviewed the plan. Later Dr. Smith signed the report. Dr. Smith approved the budget.";
    const { concepts } = extractConcepts([unit("d", text)]);
    expect(concepts.find((c) => c.kind === "person")?.key).toBe("smith");
  });
});

describe("extractConcepts：證據門檻與決定性", () => {
  it("短文件（單位數 < MIN_DOC_UNITS）不產生概念，也不被計入分析", () => {
    for (const text of ["", "你", "你好", "ab", "電纜槽 電纜槽", "好好好好好好好好好好好好"]) {
      const r = extractConcepts([unit("short", text)]);
      expect(r.concepts).toEqual([]);
    }
    expect(MIN_DOC_UNITS).toBeGreaterThan(2);
    expect(extractConcepts([unit("x", "你好")]).skippedUnits).toEqual([0]);
  });

  it("單字重複（好好好…、aaaa）不產生概念", () => {
    const r = extractConcepts([unit("d", "好好好好好好好好。好好好好好好好好。aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa")]);
    expect(r.concepts.map((c) => c.key)).toEqual([]);
  });

  it("只出現一次的詞不成為概念（freq < 2）", () => {
    const r = extractConcepts([unit("d", "alpha beta gamma delta epsilon zeta eta theta iota kappa")]);
    expect(r.concepts).toEqual([]);
  });

  it("決定性：相同輸入兩次結果完全相同（含順序、score、occurrence 位移）", () => {
    const units = [unit("A", A), unit("B", B), unit("E", "cable tray cable tray clearance clearance Ada Lovelace Ada Lovelace")];
    expect(extractConcepts(units)).toEqual(extractConcepts(units));
  });

  it("文件順序不影響概念集合與分數", () => {
    const ab = extractConcepts([unit("A", A), unit("B", B)]).concepts;
    const ba = extractConcepts([unit("B", B), unit("A", A)]).concepts;
    expect(ab).toEqual(ba);
  });

  it("occurrence 位移可直接 slice 回原文（不受正規化影響）", () => {
    const text = `Ｃable　tray 與 ${A} ${B} cable tray CABLE tray`;
    const r = extractConcepts([unit("d", text)]);
    expect(r.occurrences[0].length).toBeGreaterThan(0);
    for (const o of r.occurrences[0]) {
      const s = text.slice(o.start, o.end);
      expect(s.length).toBeGreaterThan(0);
      const key = o.id.slice(o.id.indexOf(":") + 1);
      expect(s.normalize("NFKC").toLowerCase()).toBe(key);
    }
  });

  it("score 由 freq 與 docFreq 決定：跨文件出現者較高", () => {
    const one = extractConcepts([unit("1", "cable cable cable cable tray tray tray tray more words here ok")]).concepts;
    const two = extractConcepts([
      unit("1", "cable cable tray tray more words here ok fine"),
      unit("2", "cable cable tray tray other words there ok fine"),
    ]).concepts;
    const cable1 = one.find((c) => c.key === "cable")!;
    const cable2 = two.find((c) => c.key === "cable")!;
    expect(cable1.freq).toBe(cable2.freq);
    expect(cable2.score).toBeGreaterThan(cable1.score);
  });
});

describe("splitSentences", () => {
  it("以 。！？；與換行切句；小數點與 Dr. 縮寫不切", () => {
    const text = "第一句。第二句！第三句？\n第四句；第五句 3.5 倍。Dr. Smith said hi. Next one.";
    const s = splitSentences(text).map(([a, b]) => text.slice(a, b).trim());
    expect(s).toEqual(["第一句。", "第二句！", "第三句？", "第四句；", "第五句 3.5 倍。", "Dr. Smith said hi.", "Next one."]);
  });
});
