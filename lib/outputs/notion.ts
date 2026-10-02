import { DIGEST_NOTE, type Digest } from "./digest";

/**
 * Notion 資料庫格式（JSON）。形狀對齊 Notion API 的「建立資料庫」與「建立頁面」物件：
 *   database.properties：Name(title)、Type(select)、Frequency(number)、Documents(multi_select)、Source(rich_text)
 *   pages[].properties：對應的值
 * ⚠ 沒有 Notion 帳號 / API 可驗證，**未驗證能被 Notion 實際匯入**。兩個 `parent` 都是占位符，需由使用者自行填入：
 *   先以 `database` 建立資料庫（database.parent 填頁面 ID），再把回傳的 database id 填進每個 page 的 parent。
 *
 * 已處理的限制（來源：Notion 開發者文件，2026-10-03 查閱）：
 *  - Request limits https://developers.notion.com/reference/request-limits ：rich text 的 text.content 上限 2000 字元；
 *    multi_select 一次最多 100 個選項；單一請求上限 1000 個區塊與 500KB。
 *  - Property object https://developers.notion.com/reference/property-object ：select / multi_select 選項
 *    「名稱需唯一（不分大小寫）；不可含逗號」。
 *  - 選項名稱最長 100 字元：**文件沒有明說**，這是我保守設定的上限（未驗證）。
 */
export const NOTION_FORMAT = "hyperforge/notion-database@1";
export const NOTION_SOURCES = [
  "https://developers.notion.com/reference/request-limits（2026-10-03 查閱）",
  "https://developers.notion.com/reference/property-object（2026-10-03 查閱）",
];
export const RICH_TEXT_MAX = 2000;
export const OPTION_NAME_MAX = 100;
export const MULTI_SELECT_MAX = 100;
export const REQUEST_MAX_BYTES = 500 * 1024;
export const EMPTY_OPTION_NAME = "(未命名)";

/** 把字串切成 ≤ max 個 UTF-16 code unit 的片段，不把 surrogate pair 切開。空字串回傳 []。 */
export function splitText(text: string, max = RICH_TEXT_MAX): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1; // 高位代理在片段尾端：留到下一片
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

export interface RichTextItem {
  type: "text";
  text: { content: string };
}
export const richText = (text: string): RichTextItem[] => splitText(text).map((content) => ({ type: "text", text: { content } }));

/** 選項名稱：不含逗號、空白正規化、≤100、不為空。 */
export function notionOptionName(s: string): string {
  const t = Array.from(s.replace(/[,，]/g, " ").replace(/\s+/g, " ").trim()).slice(0, OPTION_NAME_MAX).join("").trim();
  return t || EMPTY_OPTION_NAME;
}

/** 選項登錄：名稱「不分大小寫」唯一；大小寫不同者歸併到第一個出現的寫法。 */
export class OptionRegistry {
  private canon = new Map<string, string>();
  register(raw: string): string {
    const name = notionOptionName(raw);
    const key = name.toLowerCase();
    const found = this.canon.get(key);
    if (found) return found;
    this.canon.set(key, name);
    return name;
  }
  names(): string[] {
    return [...this.canon.values()].sort();
  }
}

export interface NotionExport {
  format: typeof NOTION_FORMAT;
  note: string;
  limitsSources: string[];
  /** 匯出時發生的截斷 / 超限提醒（沒有就是空陣列） */
  warnings: string[];
  database: {
    parent: { type: "page_id"; page_id: "<請填入 Notion 頁面 ID>" };
    title: RichTextItem[];
    properties: {
      Name: { title: Record<string, never> };
      Type: { select: { options: Array<{ name: string }> } };
      Frequency: { number: { format: "number" } };
      Documents: { multi_select: { options: Array<{ name: string }> } };
      Source: { rich_text: Record<string, never> };
    };
  };
  pages: Array<{
    parent: { type: "database_id"; database_id: "<建立資料庫後填入>" };
    properties: {
      Name: { title: RichTextItem[] };
      Type: { select: { name: string } };
      Frequency: { number: number };
      Documents: { multi_select: Array<{ name: string }> };
      Source: { rich_text: RichTextItem[] };
    };
  }>;
}

const TYPE_CONCEPT = "概念";
const TYPE_PERSON = "人名(heuristic)";

export function buildNotionExport(d: Digest, title = "HyperForge 知識圖譜"): NotionExport {
  const warnings: string[] = [];
  const types = new OptionRegistry();
  const docsReg = new OptionRegistry();
  const firstSentence = new Map<string, { text: string; docName: string }>();
  for (const s of d.sentences) for (const id of s.conceptIds) if (!firstSentence.has(id)) firstSentence.set(id, { text: s.text, docName: s.docName });

  let capped = 0;
  const pages: NotionExport["pages"] = d.concepts.map((c) => {
    const src = firstSentence.get(c.id);
    // 同一頁的 Documents 以「正規化後的名稱」去重（"A.md" 與 "a.md" 視為同一個選項）
    let docs = [...new Set((d.conceptDocs[c.id] ?? []).map((x) => docsReg.register(x.name)))].sort();
    if (docs.length > MULTI_SELECT_MAX) {
      capped++;
      docs = docs.slice(0, MULTI_SELECT_MAX);
    }
    return {
      parent: { type: "database_id" as const, database_id: "<建立資料庫後填入>" as const },
      properties: {
        Name: { title: richText(c.label) },
        Type: { select: { name: types.register(c.heuristic ? TYPE_PERSON : TYPE_CONCEPT) } },
        Frequency: { number: c.freq },
        Documents: { multi_select: docs.map((name) => ({ name })) },
        Source: { rich_text: src ? richText(`${src.text}（${src.docName}）`) : [] },
      },
    };
  });
  if (capped) warnings.push(`${capped} 個概念出現在超過 ${MULTI_SELECT_MAX} 份文件，Documents 只保留前 ${MULTI_SELECT_MAX} 個（Notion 單次 multi_select 上限）。`);

  const out: NotionExport = {
    format: NOTION_FORMAT,
    note: `${DIGEST_NOTE}。形狀對齊 Notion API，但未驗證能被 Notion 實際匯入。使用流程是兩步：先用 database 建立資料庫（database.parent 填入頁面 ID），再把得到的 database id 填進每個 page 的 parent。`,
    limitsSources: NOTION_SOURCES,
    warnings,
    database: {
      parent: { type: "page_id", page_id: "<請填入 Notion 頁面 ID>" },
      title: richText(title),
      properties: {
        Name: { title: {} },
        Type: { select: { options: [{ name: TYPE_CONCEPT }, { name: TYPE_PERSON }] } },
        Frequency: { number: { format: "number" } },
        Documents: { multi_select: { options: docsReg.names().map((name) => ({ name })) } },
        Source: { rich_text: {} },
      },
    },
    pages,
  };
  const dbBytes = new TextEncoder().encode(JSON.stringify(out.database)).length;
  if (dbBytes > REQUEST_MAX_BYTES) warnings.push(`資料庫定義約 ${Math.round(dbBytes / 1024)}KB，超過 Notion 單一請求 500KB 上限，無法一次建立。`);
  return out;
}

export function notionToJson(n: NotionExport): string {
  return JSON.stringify(n, null, 2) + "\n";
}
