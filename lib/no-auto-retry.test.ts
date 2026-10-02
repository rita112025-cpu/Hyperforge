import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 第 5 輪規格：禁止 timer retry / background retry / startup auto retry / 模型或網路恢復後自動重試。
// 重新建立索引只能由使用者明確觸發（按鈕）。這裡以原始碼掃描守住這條規則（行為面的證明在 store.test.ts「沒有任何自動 / 背景重試」）。
const ROOT = new URL("../", import.meta.url).pathname;
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === ".next" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".test-util.ts") ? [p] : [];
  });
}
const files = [...sources(join(ROOT, "lib")), ...sources(join(ROOT, "components")), ...sources(join(ROOT, "app"))];
const rel = (f: string) => f.replace(ROOT, "");

describe("沒有自動 / 背景重試（靜態守門）", () => {
  it("掃描到足夠多的原始檔（避免路徑錯誤造成空掃描）", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith("lib/store.ts"))).toBe(true);
  });

  it("retryIndexing 只在 store 定義，且只從 components 內的 onClick 呼叫（lib 內沒有其他呼叫點）", () => {
    const callers = files.filter((f) => /retryIndexing\s*\(/.test(strip(readFileSync(f, "utf8"))));
    const inLib = callers.filter((f) => rel(f).startsWith("lib/") && rel(f) !== "lib/store.ts");
    expect(inLib.map(rel)).toEqual([]);
    for (const f of callers.filter((f) => rel(f).startsWith("components/"))) {
      const src = strip(readFileSync(f, "utf8"));
      // 每個呼叫點都必須在使用者事件處理器（onClick / onRetry）之內，而不是 useEffect / 計時器
      expect(src, rel(f)).toMatch(/onClick|onRetry/);
      expect(src, rel(f)).not.toMatch(/useEffect\([^)]*retryIndexing|setTimeout\([^)]*retryIndexing/);
    }
  });

  it("沒有 setInterval；沒有 online / visibilitychange / focus 事件觸發重試", () => {
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      expect(src, `${rel(f)} 不得有 setInterval`).not.toMatch(/\bsetInterval\s*\(/);
      expect(src, `${rel(f)} 不得以連線 / 可見性事件觸發重試`).not.toMatch(/addEventListener\(\s*["'](online|visibilitychange|focus)["']/);
    }
  });

  it("runner / store 沒有以 setTimeout 做重試（setTimeout 只用於讓出主執行緒）", () => {
    for (const f of ["lib/pipeline/runner.ts", "lib/store.ts"]) {
      expect(strip(readFileSync(join(ROOT, f), "utf8")), f).not.toMatch(/setTimeout|requestIdleCallback|navigator\.onLine/);
    }
  });
});
