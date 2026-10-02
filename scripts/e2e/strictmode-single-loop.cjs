/**
 * 在 next dev（reactStrictMode: true，會 mount → unmount → mount）下，確認 app 的 rAF 沒有重複迴圈。
 *
 * 用法：npx next dev -p 3100   （與 next start 共用 .next，請先停掉正式伺服器）
 *       node scripts/e2e/strictmode-single-loop.cjs
 *
 * 限制（誠實聲明）：雙掛載發生在頁面載入、尚無圖譜時，舊迴圈在第一個 frame 就因沒有工作而自行停止，
 * 所以即使 cleanup 漏掉 dispose()，這個瀏覽器檢查也不會失敗（已用變異測試確認）。
 * 它只能證明「沒有觀察到雙迴圈」；dispose 的有效性由 lib/graph/frame-loop.test.ts 的 StrictMode 模擬保證。
 */
const path = require("path");
function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const root = require("child_process").execSync("npm root -g").toString().trim();
    return require(path.join(root, "playwright"));
  }
}
const { chromium } = loadPlaywright();
const BASE = `${process.env.HYPERFORGE_URL || "http://localhost:3100"}/?e2e=1`;
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function bigDoc() {
  const rnd = lcg(7); const terms = Array.from({ length: 160 }, (_, i) => `node${String(i).padStart(3, "0")}x`); const out = [];
  for (let r = 0; r < 3; r++) { const o = terms.map((t) => [rnd(), t]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); for (let i = 0; i < o.length; i += 4) out.push(o.slice(i, i + 4).join(" ") + "."); }
  return out.join(" ");
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 800 } })).newPage();
  await page.addInitScript(() => {
    window.__raf = { stamps: [], on: false };
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => orig((t) => { if (window.__raf.on) window.__raf.stamps.push(t); cb(t); });
  });
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined, null, { timeout: 60000 });
  await page.locator('input[type="file"]').setInputFiles({ name: "big.txt", mimeType: "text/plain", buffer: Buffer.from(bigDoc()) });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="persist-note"]').length >= 1, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length >= 100);
  // 等 framer-motion 進度條動畫結束，之後 rAF 只剩 app 迴圈
  await page.waitForTimeout(1500);
  const loc = page.locator('[data-testid="graph-canvas"]'); await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox();
  const s = await page.evaluate(() => window.__HYPERFORGE_E2E__.snapshot());
  const t = s.nodes.find((n) => n.sx > 80 && n.sy > 80 && n.sx < b.width - 80 && n.sy < b.height - 80);
  const p0 = { x: b.x + t.sx, y: b.y + t.sy };
  await page.mouse.move(p0.x, p0.y); await page.mouse.down();
  await page.evaluate(() => { window.__raf.stamps = []; window.__raf.on = true; });
  const start = Date.now(); let k = 0;
  while (Date.now() - start < 3000) { const a = (k++ / 40) * Math.PI * 2; await page.mouse.move(p0.x + Math.cos(a) * 100, p0.y + Math.sin(a) * 70); await page.waitForTimeout(8); }
  const st = await page.evaluate(() => { window.__raf.on = false; return window.__raf.stamps; });
  await page.mouse.up();
  const dup = st.slice(1).filter((x, i) => x === st[i]).length;
  const dur = (st.at(-1) - st[0]) / 1000;
  const perSec = st.length / dur;
  console.log(JSON.stringify({ mode: "next dev (React StrictMode on)", rAFcallbacks: st.length, seconds: +dur.toFixed(2), callbacksPerSecond: +perSec.toFixed(1), duplicateTimestamps: dup }));
  // 單一迴圈 ≈ 60 callbacks/s 且沒有同一 frame 內的重複 timestamp；雙迴圈會是 ≈120/s 且大量重複
  const ok = dup === 0 && perSec < 75;
  console.log(ok ? "PASS  StrictMode：只有一個 rAF 迴圈" : "FAIL  StrictMode：疑似多個 rAF 迴圈");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("SCRIPT ERROR", e); process.exit(2); });
