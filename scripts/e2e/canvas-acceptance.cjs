/**
 * 第 4 輪 Infinite Alchemy Canvas 的瀏覽器驗收（真實滑鼠 / 滾輪 / 鍵盤事件，Chromium headless）。
 *
 * 用法：
 *   npm run build && npm start            # 必須是正式 build，不是 dev server
 *   node scripts/e2e/canvas-acceptance.cjs
 *
 * 需求：Playwright（專案不依賴它；腳本會找 require("playwright")，找不到就找全域 npm root）。
 * 環境變數：HYPERFORGE_URL（預設 http://localhost:3000）、E2E_OUT（截圖與 JSON 輸出目錄，預設系統 tmp，不會寫進 repo）。
 *
 * Part D（第 5 輪 text-first persistence）使用 scripts/e2e/synthetic-model.cjs 的「合成模型」：由 Playwright 攔截 /models 與 /ort 請求提供，
 * 走真的 TransformersEmbedder + onnxruntime-web(WASM)，不依賴 HuggingFace；也不會放進 public/。模型沒有語意，只用來驗證流程。
 * E2E_ONLY=text-first 只跑 Part D；E2E_ONLY=text-first-edge 只跑 Part E；E2E_ONLY=embed-failure 只跑 Part C。
 *
 * 注意：此腳本預設「模型檔未安裝」（驗證狀態列為 UNAVAILABLE、reload 只發 1 個 HEAD /models 探測）。
 * 若已執行 npm run fetch-model，步驟 0 與 12 的 UNAVAILABLE 斷言會失敗——那是預期的，不是缺陷。
 * 頁面需帶 ?e2e=1 才會掛上唯讀的 window.__HYPERFORGE_E2E__（節點螢幕座標與 frame 計時），腳本會自動帶上。
 */
const fs = require("fs");
const os = require("os");
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
const { modelFiles, REPO, DIM } = require("./synthetic-model.cjs");

/** E2E_ONLY=embed-failure 只跑「模型檔看似存在但載入失敗」那一步 */
const ONLY = process.env.E2E_ONLY || "";
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "hyperforge-e2e-"));
const BASE = `${process.env.HYPERFORGE_URL || "http://localhost:3000"}/?e2e=1`;
fs.mkdirSync(OUT, { recursive: true });
console.log("output dir:", OUT);
const results = [];
const rec = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
};

const ZH_DOC = [
  "弱電橋架應與電力電纜槽保持適當間距，避免電磁干擾。電纜槽的淨距不足時，必須調整橋架的安裝高度。施工前需確認電纜槽與弱電橋架的支撐間距。",
  "混凝土澆置前應檢查鋼筋保護層厚度。鋼筋混凝土結構的養護時間依規範而定。預鑄混凝土構件進場後需檢查外觀與尺寸。",
  "消防排煙設備安裝於機房天花板，排煙風管需與電纜槽保持距離。機房內的橋架與風管應分層配置，避免施工衝突。",
  "台灣的捷運工程中，電纜槽與橋架的配置是機電整合的重點。機電整合需要協調弱電、電力、消防與空調系統。",
  "弱電系統包含監視、門禁與廣播。弱電橋架應獨立於電力電纜槽，機房內的弱電設備需與消防設備分開配置。",
].join("\n");

const HOSTILE = [
  `<img src=x onerror="window.__HYPERFORGE_XSS__=1">`,
  `<script>window.__HYPERFORGE_XSS__=2</script>`,
  `<svg onload="window.__HYPERFORGE_XSS__=3"></svg>`,
].join("\n");
const HOSTILE_DOC = `${HOSTILE}\n${HOSTILE}\nplain words around the payload payload here and there.\n`;

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
/** 220 個互異的 Latin 概念（超過 150 上限），句子內共現，用於 150-node FPS */
function bigDoc() {
  const rnd = lcg(7);
  const terms = Array.from({ length: 220 }, (_, i) => `node${String(i).padStart(3, "0")}x`);
  const sentences = [];
  // 每個詞至少出現 3 次；詞頻不同，分數有高有低
  for (let round = 0; round < 3 + 2; round++) {
    const order = terms.map((t) => [rnd(), t]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    for (let i = 0; i < order.length; i += 4) {
      if (round >= 3 && i % 3 !== 0) continue;
      sentences.push(order.slice(i, i + 4).join(" ") + ".");
    }
  }
  return sentences.join(" ");
}

async function launch() {
  const browser = await chromium.launch({ headless: true });
  return browser;
}

async function newPage(browser, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1, ...opts });
  const page = await context.newPage();
  const log = { console: [], errors: [], requests: [], modelHeads: 0, modelOther: 0, notFound: [] };
  page.on("console", (m) => log.console.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.errors.push(String(e)));
  page.on("response", (r) => { if (r.status() === 404) log.notFound.push(`${r.request().method()} ${new URL(r.url()).pathname}`); });
  page.on("request", (r) => {
    log.requests.push({ url: r.url(), method: r.method() });
    if (r.url().includes("/models/")) {
      if (r.method() === "HEAD") log.modelHeads++;
      else log.modelOther++;
    }
  });
  await page.addInitScript(() => {
    window.__wheel = null;
    window.addEventListener("wheel", (e) => (window.__wheel = { defaultPrevented: e.defaultPrevented, tag: e.target.tagName }), { passive: true });
    window.__raf = { stamps: [], on: false };
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      orig((t) => {
        if (window.__raf.on) window.__raf.stamps.push(t);
        cb(t);
      });
  });
  return { context, page, log };
}

const snap = (page) => page.evaluate(() => window.__HYPERFORGE_E2E__.snapshot());
// ───────────────────────── 合成模型（攔截 /models 與 /ort） ─────────────────────────
function ortDistDir() {
  const mod = require("module");
  const req = mod.createRequire(path.join(process.cwd(), "package.json"));
  const xenova = path.dirname(req.resolve("@xenova/transformers/package.json"));
  return path.join(path.dirname(mod.createRequire(path.join(xenova, "package.json")).resolve("onnxruntime-web/package.json")), "dist");
}
/** state = { onnxDelayMs, gets: string[] }；onnxDelayMs 為「載入 ONNX 檔」的人為延遲（模擬模型下載慢 / embedding 很慢）。 */
async function installSyntheticModel(page, state) {
  const files = modelFiles();
  const marker = `/models/${REPO}/`;
  const ort = ortDistDir();
  await page.route("**/models/**", async (route) => {
    const req = route.request();
    const rel = decodeURIComponent(new URL(req.url()).pathname).split(marker)[1];
    const buf = rel && files[rel];
    try {
      if (!buf) return await route.fulfill({ status: 404, body: "not found" });
      const type = rel.endsWith(".onnx") ? "application/octet-stream" : "application/json";
      if (req.method() === "HEAD") return await route.fulfill({ status: 200, headers: { "content-type": type }, body: "" });
      state.gets.push(rel);
      if (rel.endsWith(".onnx") && state.onnxDelayMs > 0) await new Promise((r) => setTimeout(r, state.onnxDelayMs));
      await route.fulfill({ status: 200, headers: { "content-type": type }, body: buf });
    } catch {
      /* 頁面已導航 / request 已被中止 */
    }
  });
  await page.route("**/ort/**", async (route) => {
    const file = path.join(ort, path.basename(new URL(route.request().url()).pathname));
    state.gets.push(`ort:${path.basename(file)}`);
    try {
      if (!fs.existsSync(file)) return await route.fulfill({ status: 404, body: "not found" });
      await route.fulfill({ status: 200, headers: { "content-type": file.endsWith(".wasm") ? "application/wasm" : "application/javascript" }, body: fs.readFileSync(file) });
    } catch {
      /* ignore */
    }
  });
}
/** 直接讀瀏覽器的 IndexedDB（docs / chunks / vectors 筆數；不經過 app 程式碼） */
const idbCounts = (page) =>
  page.evaluate(async () => {
    const open = indexedDB.open("hyperforge");
    const db = await new Promise((res, rej) => ((open.onsuccess = () => res(open.result)), (open.onerror = () => rej(open.error))));
    const count = (n) => new Promise((res) => ((db.transaction(n).objectStore(n).count().onsuccess = (e) => res(e.target.result))));
    const out = { docs: await count("docs"), chunks: await count("chunks"), vectors: await count("vectors") };
    db.close();
    return out;
  });
const idbFirstVector = (page) =>
  page.evaluate(async () => {
    const open = indexedDB.open("hyperforge");
    const db = await new Promise((res, rej) => ((open.onsuccess = () => res(open.result)), (open.onerror = () => rej(open.error))));
    const rows = await new Promise((res) => ((db.transaction("vectors").objectStore("vectors").getAll().onsuccess = (e) => res(e.target.result))));
    db.close();
    const v = rows[0]?.vec;
    return v ? { length: v.length, finite: Array.from(v).every(Number.isFinite), norm: Math.hypot(...Array.from(v)) } : null;
  });
async function clickNodeByLabel(page, label) {
  await page.locator('[data-testid="fit-button"]').click();
  await waitAsleep(page);
  const sn = await snap(page);
  const n = sn.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`node ${label} not found`);
  const b = await canvasBox(page);
  await page.mouse.click(b.x + n.sx, b.y + n.sy);
  await page.waitForFunction((id) => window.__HYPERFORGE_E2E__.snapshot().selection.includes(id), n.id);
  return n;
}
const sourcePanelText = (page) => page.locator('[data-testid="source-panel"]').innerText();
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function upload(page, name, content) {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content, "utf8") });
}
/** 等到至少 count 個 job 已結束（不是 running）。 */
async function waitJobDone(page, count = 1) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('[data-testid="job-status"]')].filter((e) => e.getAttribute("data-status") !== "running").length >= n,
    count,
    { timeout: 60000 },
  );
}
const jobTextLine = (page, i = 0) => page.locator('[data-testid="job-text-status"]').nth(i).innerText();
async function waitAsleep(page, ms = 90000) {
  await page.waitForFunction(() => window.__HYPERFORGE_E2E__ && window.__HYPERFORGE_E2E__.snapshot().asleep, null, { timeout: ms });
}
async function canvasBox(page) {
  const loc = page.locator('[data-testid="graph-canvas"]');
  await loc.scrollIntoViewIfNeeded();
  return loc.boundingBox();
}
const toPage = (box, n) => ({ x: box.x + n.sx, y: box.y + n.sy });
const inside = (box, n, m = 30) => n.sx > m && n.sy > m && n.sx < box.width - m && n.sy < box.height - m;
function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((x, y) => x + y, 0) / (s.length || 1);
  return { n: s.length, mean: +mean.toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), p99: +q(0.99).toFixed(3), max: +(s[s.length - 1] ?? 0).toFixed(3) };
}
function rectHit(n, r) {
  const cx = Math.min(Math.max(n.sx, r.x0), r.x1);
  const cy = Math.min(Math.max(n.sy, r.y0), r.y1);
  return Math.hypot(n.sx - cx, n.sy - cy) <= n.r * 1; // zoom 在呼叫端換算
}

async function main() {
  const browser = await launch();
  console.log("chromium", browser.version(), "| headless | cpus", require("os").cpus().length);

  // ───────────────────────── Part A：繁中匯入、互動、來源、alchemy、reload ─────────────────────────
  if (!ONLY) {
    const { page, log, context } = await newPage(browser);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);

    // 起始：空畫布顯示說明，不是空白
    rec("0. 空狀態有說明文字（非空白）", (await page.locator('[data-testid="graph-empty"]').innerText()).includes("尚無內容"));
    const vs0 = await page.locator('[data-testid="vector-status"]').innerText();
    rec("0. 模型檔缺少 → 狀態列顯示 UNAVAILABLE 且註明不影響畫布", /UNAVAILABLE/.test(vs0) && /不影響畫布/.test(vs0), vs0);

    // 1. 匯入繁中文件
    await upload(page, "電纜橋架規範.txt", ZH_DOC);
    await waitJobDone(page, 1);
    const jobText = await page.locator("main").innerText();
    rec("1. 匯入繁中文件完成；向量化略過 → PARTIAL（不是 DONE）", /PARTIAL/.test(jobText) && /向量化略過/.test(jobText));
    rec("1. 文字已持久化到 IndexedDB（與向量化無關）", /文字：已就緒/.test(await jobTextLine(page)) && /文字已存入 IndexedDB/.test(await jobTextLine(page)));

    // 2. Canvas 出現中文概念
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length > 0);
    await waitAsleep(page);
    let s = await snap(page);
    const labels = s.nodes.map((n) => n.label);
    console.log("   nodes:", labels.join(" "));
    for (const w of ["電纜槽", "橋架", "弱電"]) rec(`2. Canvas 節點包含 ${w}`, labels.includes(w));
    for (const w of ["需要", "位置", "之間", "必須", "足夠"]) if (labels.includes(w)) rec(`2. 不應出現停用詞 ${w}`, false);
    const box = await canvasBox(page);
    // 像素確認：Canvas 不是空白（有非背景像素）
    const px = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="graph-canvas"]');
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let nonBg = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) nonBg++;
      return { w: c.width, h: c.height, nonBg };
    });
    rec("2. Canvas 實際有繪製內容（非空白像素數 > 500）", px.nonBg > 500, px);
    await page.screenshot({ path: path.join(OUT, "01-zh-imported.png") });

    // 3. pan（空白處拖曳）
    {
      const spots = [[24, 24], [box.width - 24, 24], [24, box.height - 24], [box.width - 24, box.height - 24]];
      const empty = spots.find(([x, y]) => s.nodes.every((n) => Math.hypot(n.sx - x, n.sy - y) > n.r * s.viewport.zoom + 30));
      const [ex, ey] = empty;
      const v0 = s.viewport;
      await page.mouse.move(box.x + ex, box.y + ey);
      await page.mouse.down();
      await page.mouse.move(box.x + ex + 90, box.y + ey + 50, { steps: 8 });
      await page.mouse.up();
      const s2 = await snap(page);
      const dx = s2.viewport.panX - v0.panX;
      const dy = s2.viewport.panY - v0.panY;
      rec("3. pan：空白處拖曳 (+90,+50) → viewport 平移相同量，zoom 不變", Math.abs(dx - 90) < 1 && Math.abs(dy - 50) < 1 && s2.viewport.zoom === v0.zoom, { dx, dy });
      rec("3. pan 沒有改變選取", s2.selection.length === 0);
      s = s2;
    }

    // 4. wheel：以游標為中心縮放，且不帶動整頁捲動
    {
      const cxl = Math.floor(box.width * 0.62);
      const cyl = Math.floor(box.height * 0.38);
      const before = await snap(page);
      const wx = (cxl - before.viewport.panX) / before.viewport.zoom;
      const wy = (cyl - before.viewport.panY) / before.viewport.zoom;
      const scrollBefore = await page.evaluate(() => window.scrollY);
      await page.mouse.move(box.x + cxl, box.y + cyl);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(150);
      const after = await snap(page);
      const sxA = wx * after.viewport.zoom + after.viewport.panX;
      const syA = wy * after.viewport.zoom + after.viewport.panY;
      const scrollAfter = await page.evaluate(() => window.scrollY);
      const wheelInfo = await page.evaluate(() => window.__wheel);
      rec("4. wheel zoom：向上滾 → 放大", after.viewport.zoom > before.viewport.zoom, { from: before.viewport.zoom, to: after.viewport.zoom });
      rec("4. 以游標為中心：游標下方的 world 點縮放後仍在原 screen 位置（誤差 < 0.5px）", Math.abs(sxA - cxl) < 0.5 && Math.abs(syA - cyl) < 0.5, { dxErr: +(sxA - cxl).toFixed(3), dyErr: +(syA - cyl).toFixed(3) });
      rec("4. wheel 事件 defaultPrevented = true（non-passive listener 生效）", wheelInfo && wheelInfo.defaultPrevented === true, wheelInfo);
      rec("4. 滾輪只縮放圖，整頁 scrollY 不變", scrollBefore === scrollAfter, { scrollBefore, scrollAfter });
      // 在畫布外滾輪，頁面應該正常捲動（對照組：證明頁面確實可捲動，上面的不變不是因為頁面不能捲）
      await page.mouse.move(box.x + box.width / 2, 8);
      const sy0 = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(200);
      const sy1 = await page.evaluate(() => window.scrollY);
      rec("4. 對照組：滑鼠在畫布外滾輪，整頁會捲動（證明頁面可捲）", sy1 > sy0, { sy0, sy1 });
      await page.locator('[data-testid="fit-button"]').click();
      await canvasBox(page);
    }

    // 適合畫面
    {
      await page.locator('[data-testid="fit-button"]').click();
      await page.waitForTimeout(150);
      const b = await canvasBox(page);
      const f = await snap(page);
      rec("Fit：「適合畫面」後所有節點都在畫面內", f.nodes.every((n) => n.sx > 0 && n.sy > 0 && n.sx < b.width && n.sy < b.height), { zoom: f.viewport.zoom });
      s = f;
    }

    // 5. node drag
    {
      const b = await canvasBox(page);
      s = await snap(page);
      const target = s.nodes.filter((n) => inside(b, n, 80))[0];
      const p0 = toPage(b, target);
      const k = s.viewport.zoom;
      await page.mouse.move(p0.x, p0.y);
      await page.mouse.down();
      await page.mouse.move(p0.x + 120, p0.y + 60, { steps: 12 });
      const mid = (await snap(page)).nodes.find((n) => n.id === target.id);
      rec("5. node drag：mousedown 後節點被 pin", mid.pinned === true);
      await page.waitForTimeout(500);
      const held = (await snap(page)).nodes.find((n) => n.id === target.id);
      rec("5. 拖曳中 physics 不會把節點拉走（等待 500ms 位置不變）", Math.abs(held.sx - mid.sx) < 0.01 && Math.abs(held.sy - mid.sy) < 0.01, { mid: [mid.sx, mid.sy], held: [held.sx, held.sy] });
      rec("5. 節點跟隨指標移動 (+120,+60)（誤差 < 1px，抓取偏移保留）", Math.abs(held.sx - target.sx - 120) < 1 && Math.abs(held.sy - target.sy - 60) < 1, { dx: +(held.sx - target.sx).toFixed(2), dy: +(held.sy - target.sy).toFixed(2) });
      await page.mouse.up();
      const rel = (await snap(page)).nodes.find((n) => n.id === target.id);
      rec("5. mouseup 後釋放 pin", rel.pinned === false);
      rec("5. 拖曳不會改變選取", (await snap(page)).selection.length === 0);
      await waitAsleep(page);
    }

    // 6. box select（Shift+拖曳；正向與反向；框選模式）
    {
      const b = await canvasBox(page);
      s = await snap(page);
      const k = s.viewport.zoom;
      const r = { x0: b.width * 0.15, y0: b.height * 0.2, x1: b.width * 0.85, y1: b.height * 0.8 };
      const expected = s.nodes.filter((n) => Math.hypot(n.sx - Math.min(Math.max(n.sx, r.x0), r.x1), n.sy - Math.min(Math.max(n.sy, r.y0), r.y1)) <= n.r * k).map((n) => n.id).sort();
      const drag = async (x0, y0, x1, y1, shift) => {
        if (shift) await page.keyboard.down("Shift");
        await page.mouse.move(b.x + x0, b.y + y0);
        await page.mouse.down();
        await page.mouse.move(b.x + x1, b.y + y1, { steps: 10 });
        await page.mouse.up();
        if (shift) await page.keyboard.up("Shift");
      };
      await drag(r.x0, r.y0, r.x1, r.y1, true);
      const fwd = (await snap(page)).selection.sort();
      rec("6. box select（Shift+拖曳，左上→右下）選到的節點 = 與矩形相交的節點", JSON.stringify(fwd) === JSON.stringify(expected) && fwd.length > 0, { selected: fwd.length, expected: expected.length });
      // 清除後反向
      await page.mouse.click(b.x + 6, b.y + 6);
      await drag(r.x1, r.y1, r.x0, r.y0, true);
      const rev = (await snap(page)).selection.sort();
      rec("6. 反向拖曳（右下→左上）得到相同選取", JSON.stringify(rev) === JSON.stringify(expected), { selected: rev.length });
      await page.mouse.click(b.x + 6, b.y + 6);
      await drag(r.x1, r.y0, r.x0, r.y1, true);
      const mix = (await snap(page)).selection.sort();
      rec("6. 右上→左下 也相同", JSON.stringify(mix) === JSON.stringify(expected));
      await page.screenshot({ path: path.join(OUT, "02-boxselect.png") });
      // 框選模式（不按 Shift）
      await page.mouse.click(b.x + 6, b.y + 6);
      await page.locator('[data-testid="boxmode-toggle"]').click();
      const vBefore = (await snap(page)).viewport;
      await drag(r.x0, r.y0, r.x1, r.y1, false);
      const sm = await snap(page);
      rec("6. 框選模式：空白處直接拖曳 = 框選（不是平移）", JSON.stringify(sm.selection.sort()) === JSON.stringify(expected) && sm.viewport.panX === vBefore.panX, { selected: sm.selection.length });
      await page.locator('[data-testid="boxmode-toggle"]').click();
      await page.mouse.click(b.x + 6, b.y + 6);
    }

    // 7. click node + 8. source panel
    {
      const b = await canvasBox(page);
      s = await snap(page);
      const target = s.nodes.find((n) => n.label === "電纜槽") ?? s.nodes[0];
      const p = toPage(b, target);
      await page.mouse.click(p.x, p.y);
      const sel = (await snap(page)).selection;
      rec("7. click node → 選取該節點", sel.length === 1 && sel[0] === target.id, sel);
      const panel = page.locator('[data-testid="source-panel"]');
      const concept = await panel.locator('[data-testid="source-concept"]').innerText();
      const type = await panel.locator('[data-testid="source-type"]').innerText();
      const freq = await panel.locator('[data-testid="source-frequency"]').innerText();
      const docs = await panel.locator('[data-testid="source-documents"]').innerText();
      const chunks = await panel.locator('[data-testid="source-chunks"]').innerText();
      const snippets = await panel.locator('[data-testid="source-snippets"]').innerText();
      const marked = await panel.locator("mark").allInnerTexts();
      rec("8. Source panel：Concept", concept === target.label, concept);
      rec("8. Source panel：Type（概念，中文標示統計近似）", type === "概念" && /統計近似，非中文斷詞/.test(await panel.innerText()), type);
      rec("8. Source panel：Frequency 為正整數", /^\d+$/.test(freq) && Number(freq) >= 2, freq);
      rec("8. Source panel：Documents 含檔名", /電纜橋架規範\.txt/.test(docs), docs);
      rec("8. Source panel：Chunks 含 #0", /#0/.test(chunks), chunks);
      rec("8. Source panel：Original text 有原文片段，命中詞被標示", snippets.length > 20 && marked.length > 0 && marked.every((m) => m === target.label), { marks: marked.length });
      await page.screenshot({ path: path.join(OUT, "03-source-panel.png") });
    }

    // 9. hostile HTML（同頁匯入）
    {
      const before = await page.evaluate(() => ({ img: document.querySelectorAll("img").length, script: document.querySelectorAll("script").length, svg: document.querySelectorAll("svg").length }));
      await upload(page, `<img src=x onerror=window.__HYPERFORGE_XSS__=4>.txt`, HOSTILE_DOC);
      await waitJobDone(page, 2);
      await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.some((n) => n.label === "onerror"));
      await waitAsleep(page);
      const b = await canvasBox(page);
      const sn = await snap(page);
      for (const key of ["onerror", "script", "onload"]) {
        const n = sn.nodes.find((x) => x.label.toLowerCase() === key);
        if (!n) { rec(`9. hostile fixture 產生 ${key} 節點`, false); continue; }
        // 該節點可能在畫面外：用 fit 後再點
        await page.locator('[data-testid="fit-button"]').click();
        await page.waitForTimeout(100);
        const nn = (await snap(page)).nodes.find((x) => x.id === n.id);
        const p = toPage(await canvasBox(page), nn);
        await page.mouse.click(p.x, p.y);
        const sel = (await snap(page)).selection;
        const text = await page.locator('[data-testid="source-panel"]').innerText();
        const literal = { onerror: `<img src=x onerror="window.__HYPERFORGE_XSS__=1">`, script: `<script>window.__HYPERFORGE_XSS__=2</script>`, onload: `<svg onload="window.__HYPERFORGE_XSS__=3"></svg>` }[key];
        rec(`9. 點選 ${key} 節點，Source panel 顯示字面文字`, sel.includes(n.id) && text.includes(literal), sel.length);
      }
      const after = await page.evaluate(() => ({
        img: document.querySelectorAll("img").length,
        script: document.querySelectorAll("script").length,
        svg: document.querySelectorAll("svg").length,
        panelBad: document.querySelectorAll('[data-testid="source-panel"] img, [data-testid="source-panel"] script, [data-testid="source-panel"] svg, [data-testid="source-panel"] iframe').length,
        mainBad: document.querySelectorAll("main img, main svg, main iframe, main object, main embed").length,
        xss: window.__HYPERFORGE_XSS__,
        xssKeys: Object.keys(window).filter((k) => k.includes("XSS")),
        fileNameShown: document.body.innerText.includes("<img src=x onerror=window.__HYPERFORGE_XSS__=4>.txt"),
      }));
      rec("9. 匯入 hostile 後 DOM 沒有新增 img / script / svg 元素", after.img === before.img && after.script === before.script && after.svg === before.svg && after.panelBad === 0 && after.mainBad === 0, { before, after });
      rec("9. window.__HYPERFORGE_XSS__ 未被設定（undefined、window 上無此 key）", after.xss === undefined && after.xssKeys.length === 0, after.xssKeys);
      rec("9. hostile 檔名也以純文字顯示", after.fileNameShown);
      await page.screenshot({ path: path.join(OUT, "04-hostile.png") });
    }

    // 10. alchemy temporary node
    {
      await page.locator('[data-testid="fit-button"]').click();
      await page.waitForTimeout(100);
      const b = await canvasBox(page);
      s = await snap(page);
      await page.mouse.click(b.x + 6, b.y + 6);
      const cands = s.nodes.filter((n) => !n.temporary && inside(b, n, 20)).slice(0, 3);
      for (const c of cands.slice(0, 2)) {
        await page.keyboard.down("Shift");
        const p = toPage(b, (await snap(page)).nodes.find((n) => n.id === c.id));
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up("Shift");
      }
      const sel2 = (await snap(page)).selection;
      rec("10. Shift+點擊多選 2 個節點", sel2.length === 2, sel2.length);
      const last = toPage(b, (await snap(page)).nodes.find((n) => n.id === cands[1].id));
      await page.mouse.click(last.x, last.y, { button: "right" });
      const menuVisible = await page.locator('[data-testid="canvas-menu"]').isVisible();
      rec("10. 右鍵 → 出現選單，保留多選", menuVisible && (await snap(page)).selection.length === 2);
      await page.locator('[data-testid="menu-alchemy"]').click();
      const NAME = "我的暫存概念X";
      await page.locator('[data-testid="alchemy-name"]').fill(NAME);
      await page.locator('[data-testid="alchemy-submit"]').click();
      await page.waitForFunction((n) => window.__HYPERFORGE_E2E__.snapshot().nodes.some((x) => x.temporary && x.label === n), NAME);
      const s3 = await snap(page);
      const temp = s3.nodes.find((n) => n.temporary);
      rec("10. 建立暫存節點（使用者命名），標記 temporary", !!temp && temp.label === NAME, temp && temp.label);
      const panelText = await page.locator('[data-testid="source-panel"]').innerText();
      rec("10. Source panel 標示「暫存」且說明不寫入 IndexedDB", /暫存/.test(panelText) && /未寫入 IndexedDB/.test(panelText));
      // 預設命名（A × B）
      const dbDump = await page.evaluate(async () => {
        const open = indexedDB.open("hyperforge");
        const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
        const names = [...db.objectStoreNames];
        const dump = {};
        for (const n of names) {
          dump[n] = await new Promise((res, rej) => { const r = db.transaction(n).objectStore(n).getAll(); r.onsuccess = () => res(r.result.length); r.onerror = () => rej(r.error); });
        }
        const all = [];
        for (const n of names.filter((x) => x !== "vectors")) {
          const rows = await new Promise((res) => { const r = db.transaction(n).objectStore(n).getAll(); r.onsuccess = () => res(r.result); });
          all.push(JSON.stringify(rows));
        }
        db.close();
        return { counts: dump, containsTemp: all.join("").includes("我的暫存概念X") };
      });
      rec("10. 暫存節點沒有寫進 IndexedDB（所有 store 都搜尋不到該名稱）", dbDump.containsTemp === false, dbDump.counts);
      await page.screenshot({ path: path.join(OUT, "05-alchemy.png") });
    }

    // 11. reload：由 IndexedDB 重建，暫存節點消失
    {
      const labelsBefore = (await snap(page)).nodes.filter((n) => !n.temporary).map((n) => n.label).sort();
      log.modelHeads = 0;
      log.modelOther = 0;
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
      await page.waitForFunction(() => /IndexedDB 已載入 \d+ 份文字/.test(document.querySelector('[data-testid="graph-source"]')?.textContent ?? ""));
      await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length > 0);
      await waitAsleep(page);
      const s4 = await snap(page);
      const labelsAfter = s4.nodes.map((n) => n.label).sort();
      const src = await page.locator('[data-testid="graph-source"]').innerText();
      rec("11. reload 後由 IndexedDB 重建：節點集合與 reload 前相同（不含暫存）", JSON.stringify(labelsAfter) === JSON.stringify(labelsBefore), { before: labelsBefore.length, after: labelsAfter.length });
      rec("11. reload 後本次匯入(記憶體)為 0 份，資料全來自 IndexedDB", /本次匯入（記憶體）0 份/.test(src) && /IndexedDB 已載入 2 份文字/.test(src), src);
      rec("11. 暫存節點在 reload 後消失（預期行為）", s4.nodes.every((n) => !n.temporary));
      rec("11. reload 路徑只有狀態探測的 1 個 HEAD /models 請求（缺模型即停止）；getVectorStore / embedder 若被呼叫會再多 4 個平行 HEAD，且沒有任何載入模型的請求", log.modelHeads === 1 && log.modelOther === 0, { heads: log.modelHeads, other: log.modelOther });
      // 12. 模型 unavailable 時 Canvas 仍存在
      const vs = await page.locator('[data-testid="vector-status"]').innerText();
      rec("12. 模型 unavailable：狀態列 UNAVAILABLE，Canvas 仍有節點（非空）", /UNAVAILABLE/.test(vs) && s4.nodes.length > 0, vs);
      const px2 = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="graph-canvas"]');
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let nonBg = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) nonBg++;
        return nonBg;
      });
      rec("12. reload 後 Canvas 實際有繪製內容", px2 > 500, px2);
      await page.screenshot({ path: path.join(OUT, "06-after-reload.png") });
    }

    const non404 = log.console.filter((l) => /^error:/.test(l) && !/Failed to load resource: the server responded with a status of 404/.test(l));
    rec("A. 頁面沒有 pageerror，也沒有 404 以外的 console.error", log.errors.length === 0 && non404.length === 0, { pageerrors: log.errors, otherConsoleErrors: non404 });
    const unexpected404 = log.notFound.filter((u) => !/^HEAD \/models\//.test(u));
    rec("A. 所有 404 都只是「模型檔探測（HEAD /models/…）」——模型本來就沒安裝；沒有其他資源 404", unexpected404.length === 0, { total404: log.notFound.length, unexpected: unexpected404, sample: log.notFound.slice(0, 2) });
    const origins = [...new Set(log.requests.map((r) => new URL(r.url).origin))];
    rec("A. 所有請求的 origin 只有 localhost:3000", origins.length === 1 && origins.length === 1, origins);
    await context.close();
  }

  // ───────────────────────── Part B：150-node FPS / frame time ─────────────────────────
  if (!ONLY) {
    const { page, log, context } = await newPage(browser);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
    const doc = bigDoc();
    await upload(page, "big-graph.txt", doc);
    await waitJobDone(page, 1);
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length >= 150);
    const t0 = Date.now();
    const s0 = await snap(page);
    rec("13. 150-node：節點數 = 150（上限），且 UI 明示「顯示前 150 個概念」", s0.nodes.length === 150 && /顯示前 150 個概念/.test(await page.locator('[data-testid="truncation-notice"]').innerText()), { nodes: s0.nodes.length, notice: await page.locator('[data-testid="truncation-notice"]').innerText() });
    const counts = await page.locator('[data-testid="graph-counts"]').innerText();
    console.log("   counts:", counts);
    await page.screenshot({ path: path.join(OUT, "07-150-nodes.png") });

    // (a) 匯入後的收斂階段（physics 醒著時）的 frame
    await page.evaluate(() => { window.__HYPERFORGE_E2E__.resetPerf(); window.__raf.stamps = []; window.__raf.on = true; });
    const settleStart = Date.now();
    await page.waitForTimeout(4000);
    const asleepNow = (await snap(page)).asleep;
    const a = await page.evaluate(() => { window.__raf.on = false; return { stamps: window.__raf.stamps, perf: window.__HYPERFORGE_E2E__.perf() }; });
    const iv = a.stamps.slice(1).map((t, i) => t - a.stamps[i]);
    const settleFps = a.stamps.length > 1 ? ((a.stamps.length - 1) / ((a.stamps.at(-1) - a.stamps[0]) / 1000)) : 0;
    console.log("   (a) settle window: asleep at end =", asleepNow, "| rAF frames =", a.stamps.length);
    rec("13a. 收斂階段 frame（physics 醒著）", a.perf.frames > 30, { fps: +settleFps.toFixed(1), frameInterval: stats(iv), appWorkMs: stats(a.perf.workMs) });

    // (b) 拖曳節點：持續喚醒 physics + 每個 frame tick + draw（最壞情況）
    const b = await canvasBox(page);
    const sn = await snap(page);
    const target = sn.nodes.filter((n) => inside(b, n, 60))[0];
    const p0 = toPage(b, target);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.evaluate(() => { window.__HYPERFORGE_E2E__.resetPerf(); window.__raf.stamps = []; window.__raf.on = true; });
    const dragStart = Date.now();
    const DUR = 6000;
    let k = 0;
    while (Date.now() - dragStart < DUR) {
      const ang = (k++ / 40) * Math.PI * 2;
      await page.mouse.move(p0.x + Math.cos(ang) * 140, p0.y + Math.sin(ang) * 90);
      await page.waitForTimeout(8);
    }
    const awakeDuringDrag = !(await snap(page)).asleep;
    const d = await page.evaluate(() => { window.__raf.on = false; return { stamps: window.__raf.stamps, perf: window.__HYPERFORGE_E2E__.perf() }; });
    await page.mouse.up();
    const iv2 = d.stamps.slice(1).map((t, i) => t - d.stamps[i]);
    const dragFps = (d.stamps.length - 1) / ((d.stamps.at(-1) - d.stamps[0]) / 1000);
    rec("13b. 拖曳 150 節點（持續 tick+draw）：實測 FPS / frame time", d.perf.frames > 60, { durationMs: Date.now() - dragStart, rAFframes: d.stamps.length, fps: +dragFps.toFixed(1), frameInterval: stats(iv2), appWorkMs: stats(d.perf.workMs), physicsAwakeDuringDrag: awakeDuringDrag });

    // (c) 放開後會休眠；休眠後 frame 停止（不空轉）
    await waitAsleep(page, 120000);
    await page.evaluate(() => { window.__raf.stamps = []; window.__raf.on = true; });
    await page.waitForTimeout(1500);
    const idle = await page.evaluate(() => { window.__raf.on = false; return window.__raf.stamps.length; });
    rec("13c. physics 休眠後 rAF 迴圈停止（1.5 秒內 app frame = 0；不空轉）", idle === 0, { rAFcallbacksIn1500ms: idle });
    await context.close();
  }

  // ───────────────────────── Part C：模型檔「看似存在」但載入／推論失敗（審查意見 [阻擋]1 的真實瀏覽器重現） ─────────────────────────
  if (!ONLY || ONLY === "embed-failure") {
    const { page, log, context } = await newPage(browser);
    // HEAD 探測回 200（isAvailable = true），但實際載入模型的 GET 仍是 404 → 真的 TransformersEmbedder 在向量化階段失敗
    await page.route("**/models/**", (route) =>
      route.request().method() === "HEAD"
        ? route.fulfill({ status: 200, headers: { "content-type": "application/octet-stream" }, body: "" })
        : route.continue(),
    );
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
    await upload(page, "電纜橋架規範.txt", ZH_DOC);
    await waitJobDone(page, 1).catch(() => {});
    const text = await page.locator("main").innerText();
    rec("14. 向量化失敗（模型檔看似存在、載入失敗）：job 是 PARTIAL，不是 ERROR", /PARTIAL/.test(text) && !/\bERROR\b/.test(text), text.match(/(PARTIAL|ERROR)[^\n]*/)?.[0]);
    rec("14. LINK 階段如實註記「向量化失敗」且不使用假向量", /向量化失敗/.test(text) && /不使用假向量/.test(text));
    const nodes = await page.evaluate(() => window.__HYPERFORGE_E2E__.snapshot().nodes.map((n) => n.label)).catch(() => []);
    rec("14. 畫布仍有概念（電纜槽 / 橋架 / 弱電）——不是『embedding 成功才有圖』", ["電纜槽", "橋架", "弱電"].every((w) => nodes.includes(w)), nodes.length);
    rec("14. 文字仍持久化到 IndexedDB", /文字已存入 IndexedDB/.test(await jobTextLine(page).catch(() => "")));
    const failLine = await page.locator('[data-testid="job-vector-status"]').first().innerText().catch(() => "");
    rec("14. 顯示「文字可用 / 語意索引失敗」並提供「重新建立索引」", /語意索引：失敗/.test(failLine) && /文字已保留/.test(failLine) && (await page.locator('[data-testid="retry-indexing"]').count()) >= 1, failLine);
    await context.close();
  }

  // ───────────────────────── Part D：第 5 輪 Text-first persistence / Cancellation semantics ─────────────────────────
  if (!ONLY || ONLY === "text-first") {
    const state = { onnxDelayMs: 8000, gets: [] };
    const { page, log, context } = await newPage(browser);
    await installSyntheticModel(page, state);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
    const vs = await page.locator('[data-testid="vector-status"]').innerText();
    rec("D0. 合成模型就緒：狀態列 AVAILABLE（走真的 TransformersEmbedder 路徑；模型沒有語意，只驗證流程）", /AVAILABLE/.test(vs) && !/UNAVAILABLE/.test(vs), vs);

    // D1：匯入 + embedding 人為延遲 → Canvas 在 embedding 完成前出現
    const DELAY = state.onnxDelayMs;
    const t0 = Date.now();
    await upload(page, "電纜橋架規範.txt", ZH_DOC);
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length > 0, null, { timeout: 6000 });
    const tCanvas = Date.now() - t0;
    const statusAtCanvas = await page.locator('[data-testid="job-status"]').first().getAttribute("data-status");
    rec(`D1. 匯入 → Canvas 在 embedding 完成前出現（embedding 人為延遲 ${DELAY} ms；Canvas 出現於 ${tCanvas} ms，此時 job 仍是 running）`, statusAtCanvas === "running" && tCanvas < DELAY - 2000, { tCanvas, statusAtCanvas });
    const textLine = await jobTextLine(page);
    const vecLine = await page.locator('[data-testid="job-vector-status"]').first().innerText();
    rec("D1. 匯入中顯示：文字：已就緒 / 語意索引：建立中", /文字：已就緒/.test(textLine) && /語意索引：建立中/.test(vecLine), { textLine, vecLine });
    await waitAsleep(page);
    const nodes1 = (await snap(page)).nodes.map((n) => n.label);
    rec("D1. Canvas 已有中文概念（電纜槽 / 橋架 / 弱電）", ["電纜槽", "橋架", "弱電"].every((w) => nodes1.includes(w)), nodes1.length);
    const db1 = await idbCounts(page);
    rec("D1. 此刻 IndexedDB：docs=1、chunks>0、vectors=0（文字已 commit、向量尚未）", db1.docs === 1 && db1.chunks > 0 && db1.vectors === 0, db1);
    // Canvas 可互動：點選節點、source panel 有內容（embedding 仍在進行中）
    await clickNodeByLabel(page, "電纜槽");
    const panel1 = await sourcePanelText(page);
    rec("D1. embedding 進行中 Canvas 仍可互動：點選節點 → Source panel 顯示電纜槽與原文", /電纜槽/.test(panel1) && /Original text/i.test(panel1) && (await page.locator('[data-testid="graph-canvas"]').count()) === 1);
    await page.screenshot({ path: path.join(OUT, "D1-canvas-before-embedding-done.png") });

    // D2：取消 embedding
    const tCancelStart = Date.now();
    await page.locator('[data-testid="cancel-job"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="job-status"]')?.getAttribute("data-status") === "cancelled", null, { timeout: 4000 });
    const tCancelled = Date.now() - t0;
    rec(`D2. 取消 embedding 即時生效（取消於 ${tCancelled} ms，早於延遲 ${DELAY} ms；不必等 embedding 結束）`, tCancelled < DELAY, { tCancelled, cancelTookMs: Date.now() - tCancelStart });
    rec("D2. 模型載入確實已開始（取消發生在 embedding 進行中，不是 embedding 之前）", state.gets.some((g) => g.endsWith(".onnx")), state.gets);
    const label = await page.locator('[data-testid="job-status"]').first().innerText();
    const textAfter = await jobTextLine(page);
    const vecAfter = await page.locator('[data-testid="job-vector-status"]').first().innerText();
    rec("D2. job = CANCELLED（不是 PARTIAL）；顯示：文字已保留 / 語意索引已取消 / 可重新建立索引", /CANCELLED/.test(label) && !/PARTIAL/.test(label) && /文字：已就緒/.test(textAfter) && /語意索引：已取消/.test(vecAfter) && /文字已保留/.test(vecAfter) && (await page.locator('[data-testid="retry-indexing"]').count()) >= 1, { label, textAfter, vecAfter });
    const nodes2 = (await snap(page)).nodes.map((n) => n.label);
    rec("D2. 取消後 Canvas 文件仍存在（節點未消失）", nodes2.length === nodes1.length && (await page.locator('[data-testid="doc-row"]').count()) === 1);
    rec("D2. 取消後文件沒有被標成錯誤（文件列沒有紅色樣式）", (await page.locator('[data-testid="doc-row"] [class*="text-red"]').count()) === 0);
    const db2 = await idbCounts(page);
    rec("D2. 取消後 IndexedDB：docs=1、chunks 與取消前相同、vectors=0（文字不 rollback）", db2.docs === 1 && db2.chunks === db1.chunks && db2.vectors === 0, db2);
    // 取消後底層 embedding 在背景完成：不得偷偷寫入向量
    await sleepMs(Math.max(0, DELAY - tCancelled) + 3500);
    const db2b = await idbCounts(page);
    rec("D2. 放行 / 背景 embedding 完成後仍然 vectors=0（取消後不寫入）", db2b.vectors === 0 && db2b.docs === 1, db2b);
    rec("D2. job 仍是 cancelled（沒有被背景結果改成 done / partial）", (await page.locator('[data-testid="job-status"]').first().getAttribute("data-status")) === "cancelled");

    // D3：reload
    state.gets.length = 0;
    log.modelHeads = 0;
    log.requests.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-row"]').length >= 1);
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length > 0);
    await waitAsleep(page);
    await sleepMs(1500);
    const docName = await page.locator('[data-testid="doc-name"]').first().innerText();
    const nodes3 = (await snap(page)).nodes.map((n) => n.label);
    rec("D3. reload 後文件仍存在（文件清單 + 由 IndexedDB 重建的 graph 都有）", docName === "電纜橋架規範.txt" && ["電纜槽", "橋架", "弱電"].every((w) => nodes3.includes(w)), { docName, nodes: nodes3.length });
    const orts = log.requests.filter((r) => r.url.includes("/ort/")).length;
    rec("D3. reload 不初始化 embedder：只有狀態探測的 4 個 HEAD /models，沒有任何 GET 模型檔、沒有載入 ORT wasm", log.modelHeads === 4 && state.gets.length === 0 && orts === 0, { heads: log.modelHeads, gets: state.gets, ort: orts });
    const sum3 = await page.locator('[data-testid="doc-summary"]').first().innerText();
    const idxSum3 = await page.locator('[data-testid="index-summary"]').innerText();
    rec("D3. reload 後語意索引顯示未完成（尚未建立）且可重新建立索引", /語意索引：尚未建立/.test(sum3) && /未完成 1 份/.test(idxSum3) && (await page.locator('[data-testid="retry-indexing"]').count()) === 1, { sum3, idxSum3 });
    rec("D3. reload 後沒有任何 job 卡片（文字與索引狀態都由 IndexedDB 推得）", (await page.locator('[data-testid="job-status"]').count()) === 0);
    await clickNodeByLabel(page, "電纜槽");
    const panel3 = await sourcePanelText(page);
    const db3 = await idbCounts(page);
    rec("D3. IndexedDB：docs / chunks 不變、vectors 仍為 0", db3.docs === db2.docs && db3.chunks === db2.chunks && db3.vectors === 0, db3);
    await page.screenshot({ path: path.join(OUT, "D3-after-reload.png") });

    // D4：Retry indexing
    state.onnxDelayMs = 0;
    const tRetry = Date.now();
    await page.locator('[data-testid="retry-indexing"]').click();
    await page.waitForFunction(() => /語意索引：已完成/.test(document.querySelector('[data-testid="doc-summary"]')?.textContent ?? ""), null, { timeout: 60000 });
    const retryMs = Date.now() - tRetry;
    const db4 = await idbCounts(page);
    const vec = await idbFirstVector(page);
    rec(`D4. 按「重新建立索引」→ 向量補寫成功（${retryMs} ms；真的 TransformersEmbedder + ORT-web WASM）：vectors = chunks`, db4.vectors === db4.chunks && db4.vectors > 0, db4);
    rec("D4. 沒有 duplicate：docs / chunks 與 retry 前完全相同", db4.docs === db3.docs && db4.chunks === db3.chunks, { before: db3, after: db4 });
    rec(`D4. 寫入的向量為 ${DIM} 維、有限值、已 L2 normalize`, vec && vec.length === DIM && vec.finite && Math.abs(vec.norm - 1) < 1e-3, vec);
    rec("D4. retry 沒有重新 PARSE：沒有新增 job 卡片", (await page.locator('[data-testid="job-status"]').count()) === 0);
    rec("D4. 這次真的載入了模型與 ORT wasm", state.gets.some((g) => g.endsWith(".onnx")) && state.gets.some((g) => g.startsWith("ort:") && g.endsWith(".wasm")), state.gets);
    rec("D4. 完成後按鈕消失、摘要為已完成", (await page.locator('[data-testid="retry-indexing"]').count()) === 0 && /已完成 1 份/.test(await page.locator('[data-testid="index-summary"]').innerText()));
    await clickNodeByLabel(page, "電纜槽");
    const panel4 = await sourcePanelText(page);
    rec("D4. Source panel 內容與取消前、reload 後完全一致（Concept / Type / Frequency / Documents / Chunks / Original text）", panel1 === panel3 && panel3 === panel4, { same13: panel1 === panel3, same34: panel3 === panel4 });
    await page.screenshot({ path: path.join(OUT, "D4-after-retry.png") });

    // D5：再次 reload → 已完成（由 DB 推得）；重新匯入同一份內容 → 不重複 embedding、不新增 docs / chunks
    state.gets.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => /語意索引：已完成/.test(document.querySelector('[data-testid="doc-summary"]')?.textContent ?? ""));
    rec("D5. 再次 reload：語意索引顯示已完成（由 IndexedDB 向量筆數推得），不再提供重新建立索引", (await page.locator('[data-testid="retry-indexing"]').count()) === 0 && state.gets.length === 0, state.gets);
    await upload(page, "電纜橋架規範.txt", ZH_DOC);
    await waitJobDone(page, 1);
    const db5 = await idbCounts(page);
    rec("D5. 重新匯入同一份內容：不新增第二份 document / chunks / vectors，也不重複 embedding（沒有載入模型）", db5.docs === db4.docs && db5.chunks === db4.chunks && db5.vectors === db4.vectors && !state.gets.some((g) => g.endsWith(".onnx")), { db5, gets: state.gets });
    rec("D5. 重新匯入的 job = DONE（文字就緒 + 語意索引完成）", (await page.locator('[data-testid="job-status"]').first().getAttribute("data-status")) === "done");
    const bad = log.errors.concat(log.console.filter((l) => /^error:/.test(l)));
    rec("D. 頁面沒有 pageerror / console.error", bad.length === 0, bad.slice(0, 5));
    await context.close();
  }

  // ───────────────────────── Part E：commit 之前取消 / 文字持久化失敗（真瀏覽器） ─────────────────────────
  if (!ONLY || ONLY === "text-first-edge") {
    // E1：job 一出現就取消（PARSE 尚未完成）→ 不留任何資料
    {
      const { page, context } = await newPage(browser);
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
      await page.evaluate(() => {
        new MutationObserver(() => {
          const b = document.querySelector('[data-testid="cancel-job"]');
          if (b && !window.__cancelClicked) {
            window.__cancelClicked = true;
            b.click(); // job 卡片一出現（PARSE 還在讀檔）就按取消
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      const big = Array.from({ length: 900000 }, (_, i) => `w${i}`).join(" "); // 約 6 MB，PARSE 需要一段時間
      await upload(page, "big.txt", big);
      await waitJobDone(page, 1);
      const st = await page.locator('[data-testid="job-status"]').first().getAttribute("data-status");
      const line = await jobTextLine(page);
      rec("E1. 在 PARSE 進行中取消 → job = CANCELLED", st === "cancelled", st);
      rec("E1. 顯示「文字未就緒（已取消，沒有留下任何資料）」，沒有向量索引列、沒有重新建立索引按鈕", /未就緒（已取消，沒有留下任何資料）/.test(line) && (await page.locator('[data-testid="job-vector-status"]').count()) === 0 && (await page.locator('[data-testid="retry-indexing"]').count()) === 0, line);
      rec("E1. Canvas 沒有文件（沒有文件列、沒有節點）", (await page.locator('[data-testid="doc-row"]').count()) === 0 && (await snap(page)).nodes.length === 0);
      const c = await idbCounts(page);
      rec("E1. IndexedDB：docs = chunks = vectors = 0（沒有半份文件）", c.docs === 0 && c.chunks === 0 && c.vectors === 0, c);
      await context.close();
    }
    // E2：文字持久化失敗（IndexedDB 寫 docs 時丟 QuotaExceededError）
    {
      const state = { onnxDelayMs: 0, gets: [] };
      const { page, context } = await newPage(browser);
      await installSyntheticModel(page, state); // 模型「可用」：藉此證明持久化失敗時刻意不做 embedding
      await page.addInitScript(() => {
        const orig = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...a) {
          if (this.name === "docs") throw new DOMException("simulated quota exceeded", "QuotaExceededError");
          return orig.apply(this, a);
        };
      });
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
      await upload(page, "電纜橋架規範.txt", ZH_DOC);
      await waitJobDone(page, 1);
      await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length > 0);
      const label = await page.locator('[data-testid="job-status"]').first().innerText();
      const line = await jobTextLine(page);
      rec("E2. 文字持久化失敗 → job = PARTIAL（不是 DONE，也不是 ERROR）", /PARTIAL/.test(label), label);
      rec("E2. 明確警示「尚未儲存，重新整理後可能遺失」（不靜默吞掉）", /尚未儲存，重新整理後可能遺失/.test(line) && (await page.locator('[data-testid="doc-unsaved"]').count()) === 1 && (await page.locator('[data-testid="unsaved-notice"]').count()) === 1, line);
      const nodes = (await snap(page)).nodes.map((n) => n.label);
      rec("E2. Canvas 仍暫時顯示該文件的概念", ["電纜槽", "橋架", "弱電"].every((w) => nodes.includes(w)), nodes.length);
      rec("E2. 保守策略：文字沒保存 → 不做 embedding（沒有載入任何模型檔 / ORT）", state.gets.length === 0, state.gets);
      rec("E2. 不提供「重新建立索引」（文字沒保存，不建立只有衍生資料的狀態）", (await page.locator('[data-testid="retry-indexing"]').count()) === 0);
      const c = await idbCounts(page);
      rec("E2. IndexedDB：docs = chunks = vectors = 0（真的沒存進去）", c.docs === 0 && c.chunks === 0 && c.vectors === 0, c);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => window.__HYPERFORGE_E2E__ !== undefined);
      await page.waitForFunction(() => /IndexedDB 已載入 \d+ 份文字/.test(document.querySelector('[data-testid="graph-source"]')?.textContent ?? ""));
      rec("E2. 重新整理後該文件確實消失（與警示一致，沒有假裝已保存）", (await snap(page)).nodes.length === 0 && (await page.locator('[data-testid="doc-row"]').count()) === 0);
      await context.close();
    }
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "acceptance-results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log("FAILED:\n" + failed.map((f) => " - " + f.name + " " + JSON.stringify(f.detail)).join("\n"));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("SCRIPT ERROR", e);
  process.exit(2);
});
