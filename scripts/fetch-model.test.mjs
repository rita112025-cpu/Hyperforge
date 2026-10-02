import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureFile } from "./fetch-model.mjs";

const body = Buffer.from("hello model");
const sha = createHash("sha256").update(body).digest("hex");
let server;
let base;
let hits = 0;
let out;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url.endsWith("good.bin")) res.end(body);
    else if (req.url.endsWith("tampered.bin")) res.end(Buffer.from("hello MODEL")); // 同大小、內容不同
    else {
      res.statusCode = 404;
      res.end("no");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

describe("ensureFile", () => {
  it("SHA 相符 → 下載並寫入；再執行不重新下載（冪等）", async () => {
    out = await mkdtemp(join(tmpdir(), "hf-"));
    const f = { path: "good.bin", size: body.length, sha256: sha };
    expect(await ensureFile(f, base, out)).toBe("downloaded");
    const before = hits;
    expect(await ensureFile(f, base, out)).toBe("skip");
    expect(hits).toBe(before);
    expect((await readFile(join(out, "good.bin"))).equals(body)).toBe(true);
    await rm(out, { recursive: true });
  });

  it("SHA 不符 → 丟錯，且輸出目錄不留任何檔（含 .part）", async () => {
    out = await mkdtemp(join(tmpdir(), "hf-"));
    await expect(ensureFile({ path: "tampered.bin", size: body.length, sha256: sha }, base, out)).rejects.toThrow("SHA256");
    expect(await readdir(out)).toEqual([]);
    await rm(out, { recursive: true });
  });

  it("本機檔案已損毀（大小對、SHA 不對）→ 視為無效並重新下載", async () => {
    out = await mkdtemp(join(tmpdir(), "hf-"));
    await writeFile(join(out, "good.bin"), Buffer.from("hello MODEL"));
    expect(await ensureFile({ path: "good.bin", size: body.length, sha256: sha }, base, out)).toBe("downloaded");
    expect((await readFile(join(out, "good.bin"))).equals(body)).toBe(true);
    await rm(out, { recursive: true });
  });

  it("HTTP 404 / 大小不符 → 丟錯，不留檔", async () => {
    out = await mkdtemp(join(tmpdir(), "hf-"));
    await expect(ensureFile({ path: "missing.bin", size: 1 }, base, out)).rejects.toThrow("404");
    await expect(ensureFile({ path: "good.bin", size: 999 }, base, out)).rejects.toThrow("大小");
    await expect(stat(join(out, "good.bin"))).rejects.toBeDefined();
    await rm(out, { recursive: true });
  });
});
