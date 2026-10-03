// Run against a server serving out/ with the real public/models and public/ort.
// PLAYWRIGHT_MODULE can point to an external playwright/playwright-core install.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const BASE = process.env.HYPERFORGE_URL || "http://localhost:4173";
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "hyperforge-hf-"));
const TEXT = [
  "弱電橋架應與電力電纜槽保持適當間距，避免電磁干擾。電纜槽的淨距不足時，必須調整橋架的安裝高度。",
  "施工前需確認電纜槽與弱電橋架的支撐間距。機電整合需要協調弱電、電力、消防與空調系統。",
  "弱電橋架應獨立於電力電纜槽。機電整合需要協調弱電與電力，避免施工衝突。",
].join("\n");

async function readDb(page) {
  return page.evaluate(async () => {
    const open = indexedDB.open("hyperforge");
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const all = (table) => new Promise((res, rej) => {
      const request = db.transaction(table).objectStore(table).getAll();
      request.onsuccess = () => res(request.result);
      request.onerror = () => rej(request.error);
    });
    const [docs, chunks, vectors, meta] = await Promise.all(["docs", "chunks", "vectors", "meta"].map(all));
    db.close();
    return {
      docs: docs.length, chunks: chunks.length, vectors: vectors.length,
      rawText: docs[0]?.rawText,
      vectorInfo: vectors.map((v) => ({ dim: v.vec.length, finite: Array.from(v.vec).every(Number.isFinite), norm: Math.hypot(...v.vec) })),
      embedMeta: meta.find((m) => m.key === "embed")?.value,
    };
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const network = [], workers = [], errors = [], results = [];
  context.on("request", (r) => network.push({ url: r.url(), method: r.method() }));
  context.on("response", (r) => {
    const record = network.findLast((n) => n.url === r.url() && n.method === r.request().method() && n.status === undefined);
    if (record) record.status = r.status();
  });
  const page = await context.newPage();
  page.on("worker", (w) => workers.push(w.url()));
  page.on("pageerror", (e) => errors.push(e.message));
  const record = (name, detail) => { results.push({ name, pass: true, detail }); console.log(`PASS ${name}`, JSON.stringify(detail)); };
  try {
    const response = await page.goto(`${BASE}/?e2e=1`);
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => !!window.__HYPERFORGE_E2E__);
    assert.equal(await page.locator("h1").innerText(), "HYPERFORGE");
    record("static HTTP / UI", { status: response.status(), origin: new URL(BASE).origin });
    await page.evaluate((text) => navigator.clipboard.writeText(text), TEXT);
    await page.locator("h1").click();
    await page.keyboard.press("Control+V");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-row"]').length === 1);
    const committed = await readDb(page);
    assert.equal(committed.docs, 1);
    assert.ok(committed.chunks > 0);
    record("global paste / text commit", { docs: committed.docs, chunks: committed.chunks, vectors: committed.vectors });
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__.snapshot().nodes.length > 0);
    record("graph", await page.evaluate(() => ({ nodes: window.__HYPERFORGE_E2E__.snapshot().nodes.length })));
    await page.waitForFunction(() => document.querySelector('[data-testid="job-status"]')?.getAttribute("data-status") === "done", null, { timeout: 180000 });
    const indexed = await readDb(page);
    assert.equal(indexed.docs, 1);
    assert.equal(indexed.vectors, indexed.chunks);
    // Windows native clipboard converts LF to CRLF; compare the pasted content.
    assert.equal(indexed.rawText.replace(/\r\n/g, "\n"), TEXT);
    assert.ok(indexed.embedMeta.model.startsWith("Xenova/paraphrase-multilingual-MiniLM-L12-v2@"));
    assert.ok(indexed.vectorInfo.every((v) => v.dim === 384 && v.finite && Math.abs(v.norm - 1) < 0.001));
    assert.ok(workers.some((url) => new URL(url).pathname.startsWith("/_next/static/")));
    const model = network.filter((n) => n.method === "GET" && /\/models\/Xenova\/paraphrase-multilingual-MiniLM-L12-v2\//.test(n.url));
    assert.ok(model.some((n) => /\/model_quantized\.onnx$/.test(n.url) && n.status === 200));
    assert.ok(model.some((n) => /\/tokenizer\.json$/.test(n.url) && n.status === 200));
    const wasm = network.filter((n) => /\/ort\/.*\.wasm$/.test(n.url) && n.status === 200);
    assert.ok(wasm.length > 0);
    record("true Worker / MiniLM / WASM / embedding", { workers, model, wasm });
    record("IndexedDB docs/chunks/vectors", indexed);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid="doc-summary"]')?.textContent.includes("語意索引：已完成"));
    const reloaded = await readDb(page);
    assert.deepEqual(reloaded, indexed);
    await page.waitForFunction(() => window.__HYPERFORGE_E2E__?.snapshot().nodes.length > 0);
    record("reload persistence / index status", { docs: reloaded.docs, vectors: reloaded.vectors, summary: await page.locator('[data-testid="doc-summary"]').innerText() });
    for (const tab of ["summary", "mindmap", "threads", "slides", "notion", "socratic", "quotecard"]) {
      const control = page.locator(`[data-testid="tab-${tab}"]`);
      await control.click();
      assert.equal(await control.getAttribute("aria-selected"), "true");
      assert.ok((await page.locator('[data-testid="outputs-panel"]').innerText()).length > 0);
    }
    record("seven output tabs", "All seven selected and rendered");
    const unexpected = network.filter((n) => /^https?:/.test(n.url) && new URL(n.url).origin !== new URL(BASE).origin);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    record("network", { requests: network.length, unexpected, pageErrors: errors });
    await page.screenshot({ path: path.join(OUT, "hf-static.png"), fullPage: true });
  } catch (e) {
    results.push({ name: "acceptance", pass: false, detail: String(e) });
    await page.screenshot({ path: path.join(OUT, "hf-static-failure.png"), fullPage: true }).catch(() => {});
    throw e;
  } finally {
    fs.writeFileSync(path.join(OUT, "hf-static-results.json"), JSON.stringify({ browser: browser.version(), base: BASE, realModel: true, results, workers, network, errors }, null, 2));
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
