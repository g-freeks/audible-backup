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
  isIgnored,
  ignoreBook,
  getAllAudiobooks,
  upsertBook,
  deleteBook,
  getAudiobookByAsin,
} from "../src/db.ts";
import { startOperation, wasCancelled, resetOperationForTest } from "../src/operations.ts";

/** Creates the on-disk output directory + a chapter mp3 that makes a book "converted". */
function markBookConverted(title: string): void {
  const bookDir = path.join(process.env.AUDIBLE_OUTPUT_DIR!, title);
  fs.mkdirSync(bookDir, { recursive: true });
  fs.writeFileSync(path.join(bookDir, "01 - Chapter 1.mp3"), "fake mp3");
}

let tmpDir: string;
let app: Hono;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-test-"));
  process.env.DB_PATH = path.join(tmpDir, "test.db");
  process.env.AUDIBLE_TARGET_DIR = path.join(tmpDir, "aax");
  process.env.AUDIBLE_OUTPUT_DIR = path.join(tmpDir, "output");
  process.env.AUDIBLE_ACTIVATION_BYTES = "deadbeef";
  process.env.USERS_DIR = path.join(tmpDir, "users");
  fs.mkdirSync(process.env.AUDIBLE_TARGET_DIR, { recursive: true });
  fs.mkdirSync(process.env.AUDIBLE_OUTPUT_DIR, { recursive: true });
  closeDb();
  app = new Hono();
  app.route("/", routes);
});

afterEach(() => {
  resetOperationForTest();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Pages ---

// The books table, its actions, and every piece of data shown on it are now
// entirely client-rendered by the React bundle — GET / just serves the SPA
// shell (see spaShell() in routes.ts). Server-side coverage for what used to
// be asserted here as HTML now lives on the JSON endpoints the client reads
// from: GET /api/books (status, ignored-books-included, per-row fields —
// see "GET /api/books" below) and GET /api/operation (the sync/cancel
// state). Rendering behavior itself belongs to test/ui/*.test.ts.
describe("GET /", () => {
  it("serves the SPA shell: external bundle, no inline script, a mount point", async () => {
    const res = await app.request("/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /<script src="\/static\/app\.js" defer><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/static\/app\.css">/);
    assert.ok(!/<script(?![^>]*src=)/.test(html), "no inline script blocks");
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
    markBookConverted("T1");
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

  it("returns books, with a derived status and no server filesystem paths", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    const res = await app.request("/api/books");
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].asin, "B000000001");
    assert.equal(data[0].status, "downloaded");
    assert.equal(data[0].chapterCount, null);
    assert.equal(data[0].aax_path, undefined, "aax_path is a server filesystem path — must not leave the server");
  });

  it("includes ignored books, with status \"ignored\" (unlike the books page's default view)", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    ignoreBook("B000000001");
    const res = await app.request("/api/books");
    const data = await res.json();
    assert.equal(data.length, 2);
    const ignored = data.find((b: { asin: string }) => b.asin === "B000000001");
    assert.equal(ignored.status, "ignored");
  });
});

function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

async function addUserAndLogin(app: Hono, name: string, activationBytes?: string): Promise<string> {
  const res = await app.request("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, activationBytes }),
  });
  return sessionCookie(res);
}

async function addUserJson(app: Hono, name: string, password?: string): Promise<Response> {
  return app.request("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
}

describe("GET /api/session", () => {
  it("reports legacy mode with no users registered", async () => {
    const res = await app.request("/api/session");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { desktop: false, current: null, others: [], legacy: true });
  });

  it("reports the signed-in user and the others available to switch to", async () => {
    const alice = await addUserAndLogin(app, "alice");
    await addUserJson(app, "bob");

    const res = await app.request("/api/session", { headers: { cookie: alice } });
    const data = await res.json();
    assert.equal(data.current, "alice");
    assert.equal(data.legacy, false);
    assert.deepEqual(data.others.map((u: { name: string }) => u.name), ["bob"]);
  });
});

describe("GET /api/session without a session cookie", () => {
  it("still answers 200 (anonymous) once users exist, rather than 401", async () => {
    await addUserJson(app, "alice");
    const res = await app.request("/api/session");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.current, null);
    assert.deepEqual(data.others.map((u: { name: string }) => u.name), ["alice"]);
  });
});

describe("POST /api/session (JSON login)", () => {
  it("logs in a passwordless user and returns session state", async () => {
    await addUserJson(app, "alice");

    const res = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    assert.equal(res.status, 200);
    assert.equal(sessionCookie(res).startsWith("session="), true);
    assert.deepEqual(await res.json(), { current: "alice", others: [] });
  });

  it("rejects an unknown user", async () => {
    const res = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nobody" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Unknown user" });
  });

  it("rejects a wrong password", async () => {
    await addUserJson(app, "alice", "secret");
    const res = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice", password: "wrong" }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Wrong password" });
  });
});

describe("DELETE /api/session (JSON logout)", () => {
  it("clears the session cookie", async () => {
    const cookie = await addUserAndLogin(app, "alice");

    const res = await app.request("/api/session", { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 204);

    const after = await app.request("/api/books", { headers: { cookie } });
    assert.equal(after.status, 401, "the destroyed session must no longer authenticate");
  });
});

describe("POST /api/users (JSON add)", () => {
  it("creates a user and returns session state", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice", activationBytes: "deadbeef" }),
    });
    assert.equal(res.status, 201);
    assert.equal(sessionCookie(res).startsWith("session="), true);
    assert.deepEqual(await res.json(), { current: "alice", others: [] });
  });

  it("rejects an invalid name", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "not a valid name!" }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });
});

describe("GET /api/settings", () => {
  it("requires a session (401, not a redirect a fetch would silently follow)", async () => {
    await addUserJson(app, "alice");
    const res = await app.request("/api/settings");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
  });

  it("returns the settings state for the signed-in user", async () => {
    const cookie = await addUserAndLogin(app, "alice", "deadbeef");

    const settings = await (await app.request("/api/settings", { headers: { cookie } })).json();
    assert.equal(settings.userName, "alice");
    assert.equal(settings.activationBytes, "deadbeef");
    assert.equal(settings.hasPassword, false);
    assert.equal(settings.desktop, false);
    assert.deepEqual(settings.audioSettings, { format: "mp3", quality: "medium" });
    assert.ok(settings.outputFormat.directory);
    assert.ok(settings.audible);
    assert.ok(settings.version);
  });
});

describe("GET /api/operation", () => {
  it("reports not running when nothing is active", async () => {
    const res = await app.request("/api/operation");
    assert.deepEqual(await res.json(), { running: false });
  });

  it("reports the active operation's type", async () => {
    startOperation("sync");
    const res = await app.request("/api/operation");
    assert.deepEqual(await res.json(), { running: true, type: "sync" });
  });
});

describe("POST /api/operation/cancel", () => {
  it("404s (JSON) when nothing is running", async () => {
    const res = await app.request("/api/operation/cancel", { method: "POST" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No operation to cancel" });
  });

  it("cancels the active operation and answers JSON", async () => {
    startOperation("sync");
    const res = await app.request("/api/operation/cancel", { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok(wasCancelled());
  });
});

describe("GET /api/operation/stream", () => {
  it("404s (JSON) when nothing is running", async () => {
    const res = await app.request("/api/operation/stream");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No active operation" });
  });

  it("streams SSE for the active operation", async () => {
    startOperation("sync");
    const res = await app.request("/api/operation/stream");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  });

  it("carries each reporter event as a named SSE event with a JSON payload", async () => {
    const reporter = startOperation("sync");
    // Emitted before the stream connects, so this also exercises replay().
    reporter.log("hello");
    reporter.progress(42, "Downloading");
    reporter.bookStart("B000000001");
    reporter.bookDone("B000000001", true);

    const res = await app.request("/api/operation/stream");
    assert.equal(res.status, 200);
    reporter.done({ success: true, summary: "ok" });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes("event: done") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    assert.match(text, /event: log\ndata: \{"type":"log","message":"hello"\}/);
    assert.match(text, /event: progress\ndata: \{"percent":42,"label":"Downloading"\}/);
    assert.match(text, /event: book\ndata: \{"asin":"B000000001","state":"processing"\}/);
    assert.match(text, /event: book\ndata: \{"asin":"B000000001","state":"done"\}/);
    assert.match(text, /event: done\ndata: \{"success":true,"summary":"ok"\}/);
  });
});

describe("operation-start JSON endpoints", () => {
  it("POST /api/sync answers { type, queued }", async () => {
    const res = await app.request("/api/sync", { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { type: "sync", queued: [] });
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("POST /api/sync refuses (409) while another operation runs", async () => {
    startOperation("sync");
    const res = await app.request("/api/sync", { method: "POST" });
    assert.equal(res.status, 409);
  });

  it("POST /api/download queues the requested ASINs, or rejects an invalid one", async () => {
    upsertBook("B000000001", { author: "A1", title: "T1" });
    const res = await app.request("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asins: ["B000000001"] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { type: "download", queued: ["B000000001"] });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const bad = await app.request("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asins: ["not-an-asin"] }),
    });
    assert.equal(bad.status, 400);
  });

  it("POST /api/download-all queues not-downloaded books for fetch and already-fetched ones for conversion", async () => {
    upsertBook("B0ALL00001", { author: "A1", title: "Not downloaded" });

    const targetDir = process.env.AUDIBLE_TARGET_DIR!;
    fs.writeFileSync(path.join(targetDir, "B0ALL00002_Ready.aax"), "");
    fs.writeFileSync(path.join(targetDir, "B0ALL00002-chapters.json"), "{}");
    fs.writeFileSync(path.join(targetDir, "B0ALL00002_Ready.jpg"), "");
    markDownloaded("B0ALL00002", "A2", "Ready", path.join(targetDir, "B0ALL00002_Ready.aax"));

    const res = await app.request("/api/download-all", { method: "POST" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.type, "download-all");
    assert.ok(data.queued.includes("B0ALL00001"), "not-downloaded book queued for fetch");
    assert.ok(data.queued.includes("B0ALL00002"), "already-downloaded book queued for conversion");
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("POST /api/download-all scopes to the given ASINs — what Download Selected posts", async () => {
    // Selected: not-downloaded (queued for fetch).
    upsertBook("B0SEL00001", { author: "A1", title: "Selected, not downloaded" });
    // Not selected: also not-downloaded, must NOT be queued.
    upsertBook("B0SEL00002", { author: "A2", title: "Not selected" });

    const res = await app.request("/api/download-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asins: ["B0SEL00001"] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.queued.includes("B0SEL00001"), "selected book is queued");
    assert.ok(!data.queued.includes("B0SEL00002"), "unselected book is left alone");
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("POST /api/convert/:asin 404s a book with no files to convert", async () => {
    const res = await app.request("/api/convert/B000000009", { method: "POST" });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.match(data.error, /not found/);
  });

  it("POST /api/convert/:asin rejects an invalid ASIN", async () => {
    const res = await app.request("/api/convert/nope", { method: "POST" });
    assert.equal(res.status, 400);
  });

  it("POST /api/prepare/:asin queues the ASIN", async () => {
    const res = await app.request("/api/prepare/B000000009", { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { type: "prepare", queued: ["B000000009"] });
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("every start endpoint 409s while an operation is already running", async () => {
    upsertBook("B000000001", { author: "A1", title: "T1" });
    startOperation("sync");

    const checks: Array<[string, RequestInit]> = [
      ["/api/download", { method: "POST" }],
      ["/api/download-all", { method: "POST" }],
      ["/api/convert/B000000001", { method: "POST" }],
      ["/api/prepare/B000000001", { method: "POST" }],
    ];
    for (const [path, init] of checks) {
      const res = await app.request(path, init);
      assert.equal(res.status, 409, `${path} should 409 while an operation is running`);
    }
  });
});

// --- Ignore / Unignore ---

describe("POST /api/ignore/:asin", () => {
  it("ignores a book", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    const res = await app.request("/api/ignore/B000000001", { method: "POST" });
    assert.equal(res.status, 204);
    assert.ok(isIgnored("B000000001"));
  });

  it("ignores an unknown ASIN (upsert)", async () => {
    const res = await app.request("/api/ignore/B099999999", { method: "POST" });
    assert.equal(res.status, 204);
    assert.ok(isIgnored("B099999999"));
  });

  it("ignored book stays in /api/books with status \"ignored\"", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");

    let res = await app.request("/api/books");
    let data = await res.json();
    assert.equal(data[0].status, "downloaded");

    await app.request("/api/ignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });

    res = await app.request("/api/books");
    data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].status, "ignored");
  });
});

describe("POST /api/unignore/:asin", () => {
  it("unignores a book", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    ignoreBook("B000000001");
    assert.ok(isIgnored("B000000001"));

    const res = await app.request("/api/unignore/B000000001", { method: "POST" });
    assert.equal(res.status, 204);
    assert.ok(!isIgnored("B000000001"));
  });

  it("unignored book's status reverts from \"ignored\" in /api/books", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    ignoreBook("B000000001");

    let res = await app.request("/api/books");
    let data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].status, "ignored");

    await app.request("/api/unignore/B000000001", {
      method: "POST",
      redirect: "manual",
    });

    res = await app.request("/api/books");
    data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].asin, "B000000001");
    assert.equal(data[0].status, "downloaded");
  });

  it("unignore is a no-op for non-ignored ASIN", async () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    const res = await app.request("/api/unignore/B000000001", { method: "POST" });
    assert.equal(res.status, 204);
    assert.ok(!isIgnored("B000000001"));
    const booksRes = await app.request("/api/books");
    const data = await booksRes.json();
    assert.equal(data.length, 1);
  });
});

// --- Delete ---

describe("POST /api/delete/:asin", () => {
  it("resets DB fields", async () => {
    markDownloaded("B000000001", "A1", "T1", "/nonexistent.aax");

    const res = await app.request("/api/delete/B000000001", { method: "POST" });
    assert.equal(res.status, 204);

    const book = getAudiobookByAsin("B000000001");
    assert.ok(book);
    assert.equal(book.downloaded_at, null);
    assert.equal(book.aax_path, null);
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

    markDownloaded("B000000001", "A1", "TestBook", aaxFile);

    await app.request("/api/delete/B000000001", { method: "POST" });

    assert.ok(!fs.existsSync(aaxFile));
    assert.ok(!fs.existsSync(chapterFile));
    assert.ok(!fs.existsSync(outputDir));
  });
});

// --- Download ---

// --- deleteBook DB function ---

describe("deleteBook", () => {
  it("nulls out download fields but preserves title/author", async () => {
    markDownloaded("B000000001", "Author", "Title", "/a.aax");
    deleteBook("B000000001");
    const book = getAudiobookByAsin("B000000001");
    assert.ok(book);
    assert.equal(book.downloaded_at, null);
    assert.equal(book.aax_path, null);
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
      "/api/convert/short",
    ]) {
      const res = await app.request(url, { method: "POST" });
      assert.equal(res.status, 400, `expected 400 for ${url}`);
    }
  });

  it("rejects invalid ASINs in the download request body", async () => {
    const res = await app.request("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asins: ["../../etc/passwd"] }),
    });
    assert.equal(res.status, 400);
  });

  it("still accepts a valid ASIN on ignore", async () => {
    upsertBook("B000000009", { author: "Author", title: "Title" });
    const res = await app.request("/api/ignore/B000000009", { method: "POST" });
    assert.equal(res.status, 204);
    assert.equal(isIgnored("B000000009"), true);
  });
});

// --- Browser downloads ---

describe("download endpoints", () => {
  it("streams converted book as a valid ZIP", async () => {
    const bookDir = path.join(tmpDir, "output", "My Book");
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(path.join(bookDir, "01 - Intro.mp3"), "mp3 bytes");
    markDownloaded("B00DOWNLD1", "Author", "My Book", "/none.aax");

    const res = await app.request("/download/converted/B00DOWNLD1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") || "", /My%20Book\.zip/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.readUInt32LE(0), 0x04034b50, "ZIP magic");
  });

  it("404s for converted download when book is not converted", async () => {
    upsertBook("B00DOWNLD2", { author: "Author", title: "Unconverted" });
    const res = await app.request("/download/converted/B00DOWNLD2");
    assert.equal(res.status, 404);
  });

  it("streams the raw AAX file", async () => {
    const aaxPath = path.join(tmpDir, "aax", "B00DOWNLD3.aax");
    fs.writeFileSync(aaxPath, "aax bytes");
    markDownloaded("B00DOWNLD3", "Author", "Raw Book", aaxPath);

    const res = await app.request("/download/aax/B00DOWNLD3");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "aax bytes");
    assert.equal(res.headers.get("content-length"), "9");
  });

  it("404s for AAX download when the file is missing", async () => {
    markDownloaded("B00DOWNLD4", "Author", "Ghost", path.join(tmpDir, "gone.aax"));
    const res = await app.request("/download/aax/B00DOWNLD4");
    assert.equal(res.status, 404);
  });

  it("rejects invalid ASINs on download routes", async () => {
    for (const url of ["/download/converted/nope", "/download/aax/nope"]) {
      const res = await app.request(url);
      assert.equal(res.status, 400, `expected 400 for ${url}`);
    }
  });
});

// --- Multi-tenant sessions ---

describe("multi-tenant mode", () => {
  function cookieFrom(res: Response): string {
    const setCookie = res.headers.get("set-cookie") || "";
    return setCookie.split(";")[0];
  }

  async function addUser(name: string, password?: string): Promise<Response> {
    return app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password }),
    });
  }

  it("runs in legacy mode when no users exist", async () => {
    const res = await app.request("/api/status");
    assert.equal(res.status, 200);
  });

  it("requires login once a user exists, and add-user signs in", async () => {
    const addRes = await addUser("alice");
    assert.equal(addRes.status, 201);
    const cookie = cookieFrom(addRes);
    assert.match(cookie, /^session=/);

    const noAuth = await app.request("/api/books");
    assert.equal(noAuth.status, 401);

    const withAuth = await app.request("/", { headers: { cookie } });
    assert.equal(withAuth.status, 200);

    const session = await (await app.request("/api/session", { headers: { cookie } })).json();
    assert.equal(session.current, "alice");
  });

  it("rejects wrong passwords and accepts correct ones", async () => {
    await addUser("bob", "secret");

    const wrong = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bob", password: "nope" }),
    });
    assert.equal(wrong.status, 401);

    const right = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bob", password: "secret" }),
    });
    assert.equal(right.status, 200);
    assert.match(cookieFrom(right), /^session=/);
  });

  it("isolates library data between users", async () => {
    const aliceCookie = cookieFrom(await addUser("alice"));
    const bobCookie = cookieFrom(await addUser("bob"));

    const { runWithUser } = await import("../src/users.ts");
    runWithUser("alice", () => {
      markDownloaded("B00ALICE01", "Author", "Alice Book", "/a.aax");
    });

    const aliceBooks = await (await app.request("/api/books", { headers: { cookie: aliceCookie } })).json();
    const bobBooks = await (await app.request("/api/books", { headers: { cookie: bobCookie } })).json();
    assert.equal(aliceBooks.length, 1);
    assert.equal(bobBooks.length, 0);
  });

  it("updates settings for the current user", async () => {
    const cookie = cookieFrom(await addUser("carol"));

    const save = await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ activationBytes: "cafebabe" }),
    });
    assert.equal(save.status, 200);

    const { getUser } = await import("../src/users.ts");
    assert.equal(getUser("carol")?.activationBytes, "cafebabe");
  });

  it("logout destroys the session", async () => {
    const cookie = cookieFrom(await addUser("dave"));

    await app.request("/api/session", { method: "DELETE", headers: { cookie } });
    const after = await app.request("/api/books", { headers: { cookie } });
    assert.equal(after.status, 401);
  });
});

// --- CSP and inline-JS-free UI ---

describe("UI security headers", () => {
  it("serves a strict Content-Security-Policy", async () => {
    const res = await app.request("/");
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });

  it("renders no inline event handlers or script blocks", async () => {
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(!html.includes("onclick="), "no inline onclick handlers");
    assert.ok(!/<script(?![^>]*src=)/.test(html), "no inline script blocks");
    assert.ok(html.includes('src="/static/app.js"'), "loads external app.js");
  });

  // Book titles are rendered client-side via React, which escapes text
  // content by construction (no dangerouslySetInnerHTML anywhere in the
  // client) — nothing server-side to assert here any more. /api/books
  // returns the raw, unescaped title as JSON, which is correct: escaping is
  // the renderer's job, not the API's.
});

describe("dark-mode form controls", () => {
  it("declares color-scheme so native controls (e.g. <select>) render legibly in dark mode", async () => {
    // Regression: without this, some engines (WebKitGTK — the desktop
    // shell's own renderer — included) kept form controls' native-drawn
    // background light even once our own dark-mode colors applied, while
    // still honoring the author's (light-on-dark) text color — unreadable
    // white-on-white text in selects like the Columns/tag pickers. Now
    // shipped in the committed, built stylesheet rather than inline in the
    // page — /static/* is served by server.ts, outside the routes sub-app
    // this file tests, so read the built file directly.
    const css = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "web", "static", "app.css"),
      "utf8",
    );
    assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/);
    assert.match(css, /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{[^}]*color-scheme:\s*dark/);
  });
});

// --- User nav discoverability ---

// The topbar, user menu, settings-page nav, and the activation-bytes
// tooltip text are all client-rendered now (Topbar.tsx, Settings.tsx,
// Login.tsx) — the session state behind them is already covered by
// "GET /api/session" and "GET /api/session without a session cookie" above.
// Rendering itself belongs to test/ui/*.test.ts.

describe("PATCH /api/settings", () => {
  async function signedIn(name: string): Promise<string> {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const setCookie = res.headers.get("set-cookie") || "";
    return setCookie.split(";")[0];
  }

  it("requires a session", async () => {
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activationBytes: "beef" }),
    });
    assert.equal(res.status, 401);
  });

  it("saves activation bytes, audio settings and output format, and returns the updated state", async () => {
    const cookie = await signedIn("kevin");
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        activationBytes: "cafef00d",
        audioFormat: "flac",
        audioQuality: "high",
        outputFormat: {
          directory: [[{ type: "tag", value: "author" }]],
          filename: [{ type: "tag", value: "chapterName" }],
        },
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.activationBytes, "cafef00d");
    assert.deepEqual(data.audioSettings, { format: "flac", quality: "high" });
    assert.deepEqual(data.outputFormat, {
      directory: [[{ type: "tag", value: "author" }]],
      filename: [{ type: "tag", value: "chapterName" }],
    });

    const { getUser } = await import("../src/users.ts");
    assert.equal(getUser("kevin")?.activationBytes, "cafef00d");
  });

  it("rejects a malformed output format instead of silently dropping it", async () => {
    const cookie = await signedIn("laura");
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ outputFormat: { directory: "not-an-array" } }),
    });
    assert.equal(res.status, 400);
  });

  it("ignores an invalid format/quality instead of saving garbage", async () => {
    const cookie = await signedIn("mallory");
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ audioFormat: "wav", audioQuality: "ultra" }),
    });
    assert.equal(res.status, 200);
    const { getUser } = await import("../src/users.ts");
    assert.equal(getUser("mallory")?.audioSettings, undefined);
  });

  it("saves a custom ffmpeg args override alongside format/quality", async () => {
    const cookie = await signedIn("heidi");
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        audioFormat: "mp3",
        audioQuality: "low",
        audioCustomEnabled: true,
        audioArgs: "-c:a libmp3lame -q:a 0",
      }),
    });
    assert.equal(res.status, 200);

    const { getUser } = await import("../src/users.ts");
    assert.deepEqual(getUser("heidi")?.audioSettings, {
      format: "mp3",
      quality: "low",
      customArgs: "-c:a libmp3lame -q:a 0",
    });
  });

  it("ignores audioArgs when audioCustomEnabled isn't set", async () => {
    const cookie = await signedIn("ivan");
    await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        audioFormat: "aac",
        audioQuality: "medium",
        audioArgs: "-c:a something-typed-but-not-enabled",
      }),
    });

    const { getUser } = await import("../src/users.ts");
    assert.deepEqual(getUser("ivan")?.audioSettings, { format: "aac", quality: "medium" });
  });

  it("drops unknown tag keys and rejects chapter-only tags outside the filename row", async () => {
    const cookie = await signedIn("nate");
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        outputFormat: {
          directory: [
            [
              { type: "tag", value: "author" },
              { type: "tag", value: "totallyMadeUp" },
              { type: "tag", value: "chapterNumber" },
            ],
          ],
          filename: [{ type: "tag", value: "chapterNumber" }],
        },
      }),
    });
    assert.equal(res.status, 200);

    const { getUser } = await import("../src/users.ts");
    assert.deepEqual(getUser("nate")?.outputFormat?.directory, [[{ type: "tag", value: "author" }]]);
  });

  it("a saved multi-level template actually changes where a converted book is found", async () => {
    const cookie = await signedIn("olivia");
    await app.request("/api/settings", {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        outputFormat: {
          directory: [[{ type: "tag", value: "author" }], [{ type: "tag", value: "title" }]],
          filename: [{ type: "tag", value: "chapterName" }],
        },
      }),
    });

    const { runWithUser, userDirs } = await import("../src/users.ts");
    runWithUser("olivia", () => {
      upsertBook("B0OUTFMT001", { author: "Iain M. Banks", title: "Consider Phlebas" });
      markDownloaded("B0OUTFMT001", "Iain M. Banks", "Consider Phlebas", "/x/B0OUTFMT001.aaxc");
    });
    const nested = path.join(userDirs("olivia").outputDir, "Iain M. Banks", "Consider Phlebas");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "Prologue.mp3"), "");

    const status = await (await app.request("/api/status", { headers: { cookie } })).json();
    assert.equal(status.converted, 1, "found under the nested author/title path the template describes");
  });
});

describe("Audible sign-in flow (JSON)", () => {
  const FAKE_HELPER = `python3 ${path.resolve(import.meta.dirname, "resources", "fake_helper.py")}`;

  async function signedInUser(name: string): Promise<string> {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (res.headers.get("set-cookie") || "").split(";")[0];
  }

  beforeEach(() => {
    process.env.AUDIBLE_HELPER = FAKE_HELPER;
  });

  afterEach(() => {
    delete process.env.AUDIBLE_HELPER;
  });

  it("step 1 returns the Amazon URL as JSON", async () => {
    const cookie = await signedInUser("alice");
    const res = await app.request("/api/audible/login-url", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ marketplace: "de" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.url, /amazon\.de\/ap\/signin/);
    assert.equal(data.marketplace, "de");
  });

  it("rejects a pasted value without an authorization code", async () => {
    const cookie = await signedInUser("alice");
    await app.request("/api/audible/login-url", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ marketplace: "de" }),
    });
    const res = await app.request("/api/audible/login-complete", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUrl: "https://www.audible.de/" }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /authorization code/i);
  });

  it("completes sign-in and reports { ok: true } (no ?sync=1 redirect trick)", async () => {
    const cookie = await signedInUser("alice");
    await app.request("/api/audible/login-url", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ marketplace: "de" }),
    });
    const res = await app.request("/api/audible/login-complete", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUrl: "https://www.audible.de/?openid.oa2.authorization_code=ABC123" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const settings = await (await app.request("/api/settings", { headers: { cookie } })).json();
    assert.equal(settings.audible.linked, true);
  });

  it("DELETE /api/audible/pending cancels a pending sign-in", async () => {
    const cookie = await signedInUser("alice");
    await app.request("/api/audible/login-url", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ marketplace: "de" }),
    });
    const res = await app.request("/api/audible/pending", { method: "DELETE", headers: { cookie } });
    assert.equal(res.status, 204);

    const settings = await (await app.request("/api/settings", { headers: { cookie } })).json();
    assert.equal(settings.audible.pending, undefined);
  });
});

describe("POST /api/library/reset", () => {
  async function signedInUser(name: string): Promise<string> {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (res.headers.get("set-cookie") || "").split(";")[0];
  }

  it("requires a session", async () => {
    const res = await app.request("/api/library/reset", { method: "POST" });
    assert.equal(res.status, 401);
  });

  it("clears the library and answers 204", async () => {
    const cookie = await signedInUser("alice");
    const res = await app.request("/api/library/reset", { method: "POST", headers: { cookie } });
    assert.equal(res.status, 204);
  });

  it("clears only the signed-in user's library, leaving other users untouched", async () => {
    const alice = await signedInUser("alice");
    const bob = await signedInUser("bob");
    const { runWithUser } = await import("../src/users.ts");
    runWithUser("alice", () => markDownloaded("B0RESET0001", "A", "Alice Book", "/a.aaxc"));
    runWithUser("bob", () => markDownloaded("B0RESET0002", "B", "Bob Book", "/b.aaxc"));

    const res = await app.request("/api/library/reset", { method: "POST", headers: { cookie: alice } });
    assert.equal(res.status, 204);

    const aliceBooks = await (await app.request("/api/books", { headers: { cookie: alice } })).json();
    const bobBooks = await (await app.request("/api/books", { headers: { cookie: bob } })).json();
    assert.equal(aliceBooks.length, 0, "alice's library is cleared");
    assert.equal(bobBooks.length, 1, "bob's library is untouched");
  });

  it("refuses (409) while an operation is running", async () => {
    const cookie = await signedInUser("alice");
    startOperation("sync");
    const res = await app.request("/api/library/reset", { method: "POST", headers: { cookie } });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.ok(data.error);
  });
});

// POST /prepare/:asin (the old HTML-fragment route) is gone — its coverage
// (invalid ASIN, queues + starts, 409 while busy) lives on
// POST /api/prepare/:asin under "operation-start JSON endpoints" above.

describe("POST /open-output", () => {
  it("does not exist outside desktop mode", async () => {
    // A server install has no desktop session to open a file manager in, and
    // the browser is often on another machine entirely.
    const res = await app.request("/open-output", { method: "POST" });
    assert.equal(res.status, 404);
  });

  // Whether the Open Folder button appears (vs. a ZIP download link) is
  // client-rendered now (Topbar.tsx branches on session.desktop) — covered
  // by test/ui/*.test.ts.
});

// Row action labels/wiring are entirely client-rendered now
// (table/RowActions.tsx implements the same one-action-per-status mapping
// the old actionButtons() in books.ts had) — no server HTML to assert
// against any more. Covered by test/ui/*.test.ts.

// --- Layout tweaks and database reset ---

// Table layout (column classes, draggable headers) is entirely
// client-rendered now (table/BooksTable.tsx, using TanStack Table's column
// order state rather than a baked-in index) — covered by test/ui/*.test.ts.

describe("GET/POST /api/table-state", () => {
  async function signedIn(name: string): Promise<string> {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (res.headers.get("set-cookie") || "").split(";")[0];
  }

  it("returns {} when nothing has been saved", async () => {
    const cookie = await signedIn("frank");
    const res = await app.request("/api/table-state", { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  });

  it("saves and reads back an arbitrary state snapshot", async () => {
    const cookie = await signedIn("grace");
    const state = {
      sorting: [{ id: "title", desc: false }],
      columnFilters: [{ id: "status", value: ["converted"] }],
      columnVisibility: { asin: false },
      columnOrder: ["title", "author"],
      columnSizing: { title: 240 },
      rowSelection: { B000000001: true },
    };
    const post = await app.request("/api/table-state", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    assert.equal(post.status, 204);

    const get = await app.request("/api/table-state", { headers: { cookie } });
    assert.deepEqual(await get.json(), state);
  });

  it("no-ops in legacy mode (no signed-in user to attach it to)", async () => {
    const res = await app.request("/api/table-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sorting: [] }),
    });
    assert.equal(res.status, 204);
  });

  it("rejects invalid JSON and non-object bodies", async () => {
    const cookie = await signedIn("heidi");
    const badJson = await app.request("/api/table-state", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: "not json",
    });
    assert.equal(badJson.status, 400);

    const arrayBody = await app.request("/api/table-state", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(arrayBody.status, 400);
  });

  it("rejects an oversized payload", async () => {
    const cookie = await signedIn("ivan");
    const res = await app.request("/api/table-state", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ blob: "x".repeat(100_000) }),
    });
    assert.equal(res.status, 400);
  });

  it("keeps each user's saved state separate", async () => {
    const alice = await signedIn("judy");
    const bob = await signedIn("kevin");

    await app.request("/api/table-state", {
      method: "POST",
      headers: { cookie: alice, "Content-Type": "application/json" },
      body: JSON.stringify({ sorting: [{ id: "title", desc: true }] }),
    });

    const bobState = await (await app.request("/api/table-state", { headers: { cookie: bob } })).json();
    assert.deepEqual(bobState, {}, "a different user sees no saved state");
  });
});


