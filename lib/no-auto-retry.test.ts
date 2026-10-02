import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 第 5 輪規格：禁止 timer retry / background retry / startup auto retry / 模型或網路恢復後自動重試。
// 重新建立索引只能由使用者明確觸發（按鈕 onClick / onRetry）。這裡以原始碼掃描守住這條規則
// （行為面的證明在 store.test.ts「沒有任何自動 / 背景重試」；那只涵蓋 store 層，擋不住元件層的 useEffect，所以需要這個檢查）。
//
// 檢查器本身（下面的 findViolations）也有單元測試：用「注入的壞原始碼」證明它真的會抓到違規，不是空轉。

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

/** 找出所有綁定到 retryIndexing 的名稱：retryIndexing 本身，以及 `const x = useForge((s) => s.retryIndexing)` 這類別名。 */
export function retryNames(src: string): string[] {
  const names = new Set(["retryIndexing"]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*\.retryIndexing\b/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{[^}]*\bretryIndexing\s*:\s*(\w+)[^}]*\}\s*=/g)) names.add(m[1]);
  return [...names];
}

/** 抽出「會在使用者事件之外執行」的函式呼叫的本體（括號平衡）：useEffect / useLayoutEffect / setTimeout / setInterval / queueMicrotask / requestAnimationFrame / requestIdleCallback。 */
export function deferredBodies(src: string): string[] {
  const bodies: string[] = [];
  for (const m of src.matchAll(/\b(useEffect|useLayoutEffect|setTimeout|setInterval|queueMicrotask|requestAnimationFrame|requestIdleCallback)\s*\(/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    bodies.push(src.slice(start, i));
  }
  return bodies;
}

/** 回傳違規描述（空陣列 = 沒有違規）。 */
export function findViolations(rawSrc: string): string[] {
  const src = strip(rawSrc);
  const out: string[] = [];
  const names = retryNames(src);
  const callOf = (n: string) => new RegExp(`\\b${n}\\s*\\(`, "g");
  for (const body of deferredBodies(src)) {
    for (const n of names) if (callOf(n).test(body)) out.push(`在 effect / 計時器內呼叫 ${n}()`);
  }
  for (const n of names) {
    if (n === "retryIndexing" && /(?:const|let|var)\s+retryIndexing\s*:/.test(src)) continue;
    // 「呼叫」數 = 非宣告的 n( 出現次數；其中必須全部位於 onClick / onRetry 處理器內
    const decl = new RegExp(`(?:^|\\s)${n}\\s*:\\s*\\(`, "g"); // store 內 `retryIndexing: async (docId) =>` 之類的定義不算呼叫
    const calls = (src.match(callOf(n)) ?? []).length - (src.match(decl) ?? []).length;
    const inHandlers = (src.match(new RegExp(`on(?:Retry|Click)=\\{[^}]*\\b${n}\\s*\\(`, "g")) ?? []).length;
    if (calls > inHandlers) out.push(`${n}() 有 ${calls - inHandlers} 處呼叫不在 onClick / onRetry 處理器內`);
  }
  if (/addEventListener\(\s*["'](online|visibilitychange|focus)["']/.test(src)) out.push("以 online / visibilitychange / focus 事件觸發");
  if (/\bsetInterval\s*\(/.test(src)) out.push("使用 setInterval");
  return out;
}

describe("檢查器自己的單元測試（注入的壞原始碼必須被抓到；好的必須通過）", () => {
  const GOOD = `
    const retry = useForge((s) => s.retryIndexing);
    useEffect(() => { loadStuff(); }, []);
    return <button onClick={() => void retry(job.docId!)}>重新建立索引</button>;`;

  it("正常：只在 onClick / onRetry 內呼叫（含別名）→ 無違規", () => {
    expect(findViolations(GOOD)).toEqual([]);
    expect(findViolations(`const retryIndexing = useForge((s) => s.retryIndexing); return <D onRetry={(id) => void retryIndexing(id)} />;`)).toEqual([]);
  });

  it("啟動時自動重試：useEffect 內呼叫（標準寫法 `useEffect(() => {…}, [])`）→ 抓到（reviewer 的重現）", () => {
    const bad = `${GOOD}\n useEffect(() => { for (const id of Object.keys(docInfo)) void retryIndexing(id); }, [docInfo, retryIndexing]);`;
    expect(findViolations(bad).length).toBeGreaterThan(0);
  });

  it("別名也抓得到：`retry` 在 useEffect / setTimeout / queueMicrotask 內被呼叫", () => {
    for (const wrap of ["useEffect(() => { retry(id); }, [])", "setTimeout(() => retry(id), 1000)", "queueMicrotask(() => { retry(id) })", "useLayoutEffect(() => { void retry(id); })"]) {
      expect(findViolations(`${GOOD}\n ${wrap}`), wrap).not.toEqual([]);
    }
  });

  it("呼叫點不在事件處理器內（例如元件主體或其他函式）→ 抓到", () => {
    expect(findViolations(`const retry = useForge((s) => s.retryIndexing);\n function auto() { retry(x); }\n return <b onClick={() => void retry(a)} />;`).join()).toMatch(/不在 onClick/);
  });

  it("setInterval、online / visibilitychange / focus 觸發 → 抓到", () => {
    expect(findViolations(`setInterval(() => {}, 1000)`)).toContain("使用 setInterval");
    for (const ev of ["online", "visibilitychange", "focus"]) {
      expect(findViolations(`window.addEventListener("${ev}", () => retryIndexing(x))`).join(), ev).toMatch(/事件觸發/);
    }
  });

  it("註解裡的字樣不算違規", () => {
    expect(findViolations(`// useEffect(() => retryIndexing(id), [])\n/* setInterval(x) */ ${GOOD}`)).toEqual([]);
  });

  it("括號平衡：effect 內有巢狀括號與箭頭函式時仍能抓到", () => {
    expect(findViolations(`useEffect(() => { items.forEach((i) => { if (f(i)) { retryIndexing(i.id); } }); }, [items])`)).not.toEqual([]);
  });
});

// ───────────── 對實際原始碼套用 ─────────────
// Windows：URL.pathname 會得到 "/D:/..."，必須用 fileURLToPath；比較相對路徑前統一成正斜線
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const norm = (p: string) => p.split("\\").join("/");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === ".next" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".test-util.ts") ? [p] : [];
  });
}
const files = [...sources(join(ROOT, "lib")), ...sources(join(ROOT, "components")), ...sources(join(ROOT, "app"))];
const rel = (f: string) => norm(f).replace(norm(ROOT), "");

describe("沒有自動 / 背景重試（對實際原始碼的靜態守門）", () => {
  it("掃描到足夠多的原始檔（避免路徑錯誤造成空掃描），且包含 store 與兩個會呼叫 retry 的元件", () => {
    expect(files.length).toBeGreaterThan(30);
    for (const f of ["lib/store.ts", "components/GraphWorkspace.tsx", "components/PipelineView.tsx"]) expect(files.some((x) => rel(x) === f), f).toBe(true);
  });

  it("每個非測試原始檔：沒有違規（retry 只在 onClick / onRetry 內；無 effect / 計時器 / 連線事件重試）", () => {
    const violations = files.flatMap((f) => findViolations(readFileSync(f, "utf8")).map((v) => `${rel(f)}: ${v}`));
    expect(violations).toEqual([]);
  });

  it("lib 內除了 store 之外，沒有任何地方呼叫 retryIndexing（含別名）", () => {
    const hits = files.filter((f) => rel(f).startsWith("lib/") && rel(f) !== "lib/store.ts").filter((f) => retryNames(strip(readFileSync(f, "utf8"))).some((n) => new RegExp(`\\b${n}\\s*\\(`).test(strip(readFileSync(f, "utf8")))));
    expect(hits.map(rel)).toEqual([]);
  });

  it("runner / store 沒有以 setTimeout / requestIdleCallback / navigator.onLine 做重試（setTimeout 只用於讓出主執行緒）", () => {
    for (const f of ["lib/pipeline/runner.ts", "lib/store.ts"]) {
      expect(strip(readFileSync(join(ROOT, f), "utf8")), f).not.toMatch(/setTimeout|requestIdleCallback|navigator\.onLine/);
    }
  });

  it("至少有一個元件真的呼叫了 retry（確認檢查對象存在，不是因為抓不到而「無違規」）", () => {
    const callers = files.filter((f) => rel(f).startsWith("components/")).filter((f) => {
      const src = strip(readFileSync(f, "utf8"));
      return retryNames(src).some((n) => new RegExp(`on(?:Retry|Click)=\\{[^}]*\\b${n}\\s*\\(`).test(src));
    });
    expect(callers.map(rel).sort()).toEqual(["components/GraphWorkspace.tsx", "components/PipelineView.tsx"]);
  });
});
