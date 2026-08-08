import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Hono } from "hono";
import { routes } from "../src/web/routes.ts";
import {
  closeDb,
  markDownloaded,
  markConverted,
  isIgnored,
  ignoreBook,
  getAllAudiobooks,
  upsertBook,
  deleteBook,
  getAudiobookByAsin,
} from "../src/db.ts";
import { clearOperation } from "../src/operations.ts";

let tmpDir: string;
let app: Hono;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-test-"));
  process.env.DB_PATH = path.join(tmpDir, "test.db");
  process.env.AUDIBLE_TARGET_DIR = path.join(tmpDir, "aax");
  process.env.AUDIBLE_OUTPUT_DIR = path.join(tmpDir, "output");
  process.env.AUDIBLE_ACTIVATION_BYTES = "deadbeef";
  fs.mkdirSync(process.env.AUDIBLE_TARGET_DIR, { recursive: true });
  fs.mkdirSync(process.env.AUDIBLE_OUTPUT_DIR, { recursive: true });
  closeDb();
  app = new Hono();
  app.route("/", routes);
});

afterEach(() => {
  clearOperation();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Pages ---

describe("GET /", () => {
  it("returns 200 with books HTML", async () => {
    const res = await app.request("/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Books"));
  });

  it("shows books in the table", async () => {
    markDownloaded("B000000001", "Author One", "Book One", "/a.aax");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes("Book One"));
    assert.ok(html.includes("Author One"));
    assert.ok(html.includes("B000000001"));
  });

  it("shows not-downloaded books with status badge", async () => {
    upsertBook("B000000001", "Author One", "Undownloaded Book");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes("Not Downloaded"));
    assert.ok(html.includes("Undownloaded Book"));
    assert.ok(html.includes("Author One"));
    assert.ok(html.includes('id="status-B000000001"'));
  });

  it("shows checkboxes for not-downloaded books", async () => {
    upsertBook("B000000001", "A1", "T1");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes('name="asin"'));
    assert.ok(html.includes('value="B000000001"'));
    assert.ok(html.includes('id="select-all"'));
  });

  it("shows download buttons when not-downloaded books exist", async () => {
    upsertBook("B000000001", "A1", "T1");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes("Download Selected"));
    assert.ok(html.includes("Download All"));
  });

  it("shows both downloaded and not-downloaded books", async () => {
    upsertBook("B000000001", "A1", "Not Yet");
    markDownloaded("B000000002", "A2", "Already Got", "/b.aax");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes("Not Yet"));
    assert.ok(html.includes("Already Got"));
    assert.ok(html.includes("Not Downloaded"));
    assert.ok(html.includes('>Downloaded<'));
  });

  it("shows ignored books in the table with Ignored badge", async () => {
    markDownloaded("B000000001", "A1", "Ignored Book", "/a.aax");
    ignoreBook("B000000001");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes("Ignored Book"));
    assert.ok(html.includes("Unignore"));
  });

  it("shows ignore buttons for non-ignored not-downloaded books", async () => {
    upsertBook("B000000001", "A1", "T1");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes("/api/ignore/B000000001"));
    assert.ok(html.includes("Ignore"));
  });

  it("shows filter pills", async () => {
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(html.includes("filter-btn"));
    assert.ok(html.includes("search-input"));
  });
});

describe("GET /library", () => {
  it("redirects to /", async () => {
    const res = await app.request("/library", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location")?.endsWith("/"));
  });
});

describe("GET /convert", () => {
  it("redirects to /", async () => {
    const res = await app.request("/convert", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location")?.endsWith("/"));
  });
});

// --- JSON API ---

describe("GET /api/status", () => {
  it("returns correct counts for empty database", async () => {
    const res = await app.request("/api/status");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.total, 0);
    assert.equal(data.downloaded, 0);
    assert.equal(data.converted, 0);
    assert.equal(data.pending, 0);
  });

  it("returns correct counts with data", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    markConverted("B000000001", "/out", 5);
    const res = await app.request("/api/status");
    const data = await res.json();
    assert.equal(data.total, 2);
    assert.equal(data.downloaded, 2);
    assert.equal(data.converted, 1);
    assert.equal(data.pending, 1);
  });

  it("excludes ignored books from counts", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    ignoreBook("B000000001");
    const res = await app.request("/api/status");
    const data = await res.json();
    assert.equal(data.total, 1);
    assert.equal(data.downloaded, 1);
  });
});

describe("GET /api/books", () => {
  it("returns empty array for empty database", async () => {
    const res = await app.request("/api/books");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  });

  it("returns books", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    const res = await app.request("/api/books");
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].asin, "B000000001");
  });

  it("excludes ignored books", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    ignoreBook("B000000001");
    const res = await app.request("/api/books");
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].asin, "B000000002");
  });
});

// --- Ignore / Unignore ---

describe("POST /api/ignore/:asin", () => {
  it("ignores a book and redirects to /", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    const res = await app.request("/api/ignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location")?.endsWith("/"));
    assert.ok(isIgnored("B000000001"));
  });

  it("ignores an unknown ASIN (upsert)", async () => {
    const res = await app.request("/api/ignore/B099999999", {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(isIgnored("B099999999"));
  });

  it("ignored book disappears from /api/books", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");

    let res = await app.request("/api/books");
    let data = await res.json();
    assert.equal(data.length, 1);

    await app.request("/api/ignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });

    res = await app.request("/api/books");
    data = await res.json();
    assert.equal(data.length, 0);
  });
});

describe("POST /api/unignore/:asin", () => {
  it("unignores a book and redirects to /", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    ignoreBook("B000000001");
    assert.ok(isIgnored("B000000001"));

    const res = await app.request("/api/unignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location")?.endsWith("/"));
    assert.ok(!isIgnored("B000000001"));
  });

  it("unignored book reappears in /api/books", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    ignoreBook("B000000001");

    let res = await app.request("/api/books");
    let data = await res.json();
    assert.equal(data.length, 0);

    await app.request("/api/unignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });

    res = await app.request("/api/books");
    data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].asin, "B000000001");
  });

  it("unignore is a no-op for non-ignored ASIN", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    const res = await app.request("/api/unignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(!isIgnored("B000000001"));
    const booksRes = await app.request("/api/books");
    const data = await booksRes.json();
    assert.equal(data.length, 1);
  });
});

// --- Delete ---

describe("POST /api/delete/:asin", () => {
  it("resets DB fields and redirects to /", async () => {
    markDownloaded("B000000001", "A1", "T1", "/nonexistent.aax");
    markConverted("B000000001", "/nonexistent/out", 5);

    const res = await app.request("/api/delete/B000000001", {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location")?.endsWith("/"));

    const book = getAudiobookByAsin("B000000001");
    assert.ok(book);
    assert.equal(book.downloaded_at, null);
    assert.equal(book.converted_at, null);
    assert.equal(book.aax_path, null);
    assert.equal(book.output_path, null);
    assert.equal(book.chapter_count, null);
    // Title and author should be preserved
    assert.equal(book.author, "A1");
    assert.equal(book.title, "T1");
  });

  it("deletes files from disk when they exist", async () => {
    const aaxFile = path.join(tmpDir, "aax", "B000000001-test.aax");
    const chapterFile = path.join(tmpDir, "aax", "B000000001-chapters.json");
    const outputDir = path.join(tmpDir, "output", "TestBook");
    fs.writeFileSync(aaxFile, "fake aax");
    fs.writeFileSync(chapterFile, "{}");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "01.mp3"), "fake mp3");

    markDownloaded("B000000001", "A1", "T1", aaxFile);
    markConverted("B000000001", outputDir, 1);

    await app.request("/api/delete/B000000001", {
      method: "POST",
      redirect: "manual",
    });

    assert.ok(!fs.existsSync(aaxFile));
    assert.ok(!fs.existsSync(chapterFile));
    assert.ok(!fs.existsSync(outputDir));
  });
});

// --- Download ---

describe("POST /library/download", () => {
  it("returns 409 when an operation is already running", async () => {
    upsertBook("B000000001", "A1", "T1");
    const res1 = await app.request("/library/download", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "asin=B000000001",
    });
    assert.equal(res1.status, 200);

    const res2 = await app.request("/library/download", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "asin=B000000001",
    });
    assert.equal(res2.status, 409);

    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("returns SSE panel HTML with download stream and OOB queued status", async () => {
    upsertBook("B000000001", "A1", "T1");
    const res = await app.request("/library/download", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "asin=B000000001",
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("sse-connect"));
    assert.ok(html.includes("/library/download/stream"));
    assert.ok(html.includes("Download started..."));
    assert.ok(html.includes('id="status-B000000001"'));
    assert.ok(html.includes("Queued"));
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});

// --- deleteBook DB function ---

describe("deleteBook", () => {
  it("nulls out download/convert fields but preserves title/author", async () => {
    markDownloaded("B000000001", "Author", "Title", "/a.aax");
    markConverted("B000000001", "/out", 10);
    deleteBook("B000000001");
    const book = getAudiobookByAsin("B000000001");
    assert.ok(book);
    assert.equal(book.downloaded_at, null);
    assert.equal(book.converted_at, null);
    assert.equal(book.aax_path, null);
    assert.equal(book.output_path, null);
    assert.equal(book.chapter_count, null);
    assert.equal(book.author, "Author");
    assert.equal(book.title, "Title");
  });
});

// --- Ignore + Status round-trip ---

describe("ignore/unignore round-trip through API", () => {
  it("ignore reduces status counts, unignore restores them", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");

    let res = await app.request("/api/status");
    let data = await res.json();
    assert.equal(data.total, 2);
    assert.equal(data.downloaded, 2);

    await app.request("/api/ignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });

    res = await app.request("/api/status");
    data = await res.json();
    assert.equal(data.total, 1);
    assert.equal(data.downloaded, 1);

    await app.request("/api/unignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });

    res = await app.request("/api/status");
    data = await res.json();
    assert.equal(data.total, 2);
    assert.equal(data.downloaded, 2);
  });
});

// --- ASIN validation ---

describe("ASIN validation", () => {
  it("rejects invalid ASINs on ignore, delete, and convert routes", async () => {
    for (const url of [
      "/api/ignore/not-an-asin",
      "/api/unignore/lowercase1",
      "/api/delete/..%2F..%2Fetc",
      "/convert/short",
    ]) {
      const res = await app.request(url, { method: "POST" });
      assert.equal(res.status, 400, `expected 400 for ${url}`);
    }
  });

  it("rejects invalid ASINs in download form body", async () => {
    const body = new URLSearchParams({ asin: "../../etc/passwd" });
    const res = await app.request("/library/download", {
      method: "POST",
      body,
    });
    assert.equal(res.status, 400);
  });

  it("still accepts a valid ASIN on ignore", async () => {
    upsertBook("B000000009", "Author", "Title");
    const res = await app.request("/api/ignore/B000000009", {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(isIgnored("B000000009"), true);
  });
});
