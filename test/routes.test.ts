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
  process.env.USERS_DIR = path.join(tmpDir, "users");
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

// --- Browser downloads ---

describe("download endpoints", () => {
  it("streams converted book as a valid ZIP", async () => {
    const bookDir = path.join(tmpDir, "output", "My Book");
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(path.join(bookDir, "01 - Intro.mp3"), "mp3 bytes");
    markDownloaded("B00DOWNLD1", "Author", "My Book", "/none.aax");
    markConverted("B00DOWNLD1", bookDir, 1);

    const res = await app.request("/download/converted/B00DOWNLD1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") || "", /My%20Book\.zip/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.readUInt32LE(0), 0x04034b50, "ZIP magic");
  });

  it("404s for converted download when book is not converted", async () => {
    upsertBook("B00DOWNLD2", "Author", "Unconverted");
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

  it("runs in legacy mode when no users exist", async () => {
    const res = await app.request("/api/status");
    assert.equal(res.status, 200);
  });

  it("requires login once a user exists, and add-user signs in", async () => {
    const addRes = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "alice" }),
      redirect: "manual",
    });
    assert.equal(addRes.status, 302);
    const cookie = cookieFrom(addRes);
    assert.match(cookie, /^session=/);

    const noAuth = await app.request("/", { redirect: "manual" });
    assert.equal(noAuth.status, 302);
    assert.equal(noAuth.headers.get("location"), "/login");

    const withAuth = await app.request("/", { headers: { cookie } });
    assert.equal(withAuth.status, 200);
    const html = await withAuth.text();
    assert.match(html, /alice/);
  });

  it("rejects wrong passwords and accepts correct ones", async () => {
    await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "bob", password: "secret" }),
      redirect: "manual",
    });

    const wrong = await app.request("/user/switch", {
      method: "POST",
      body: new URLSearchParams({ name: "bob", password: "nope" }),
      redirect: "manual",
    });
    assert.equal(wrong.status, 401);

    const right = await app.request("/user/switch", {
      method: "POST",
      body: new URLSearchParams({ name: "bob", password: "secret" }),
      redirect: "manual",
    });
    assert.equal(right.status, 302);
    assert.match(cookieFrom(right), /^session=/);
  });

  it("isolates library data between users", async () => {
    const aliceRes = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "alice" }),
      redirect: "manual",
    });
    const bobRes = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "bob" }),
      redirect: "manual",
    });
    const aliceCookie = cookieFrom(aliceRes);
    const bobCookie = cookieFrom(bobRes);

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
    const res = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "carol" }),
      redirect: "manual",
    });
    const cookie = cookieFrom(res);

    const save = await app.request("/user/settings", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ activation_bytes: "cafebabe" }),
    });
    assert.equal(save.status, 200);

    const { getUser } = await import("../src/users.ts");
    assert.equal(getUser("carol")?.activationBytes, "cafebabe");
  });

  it("logout destroys the session", async () => {
    const res = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "dave" }),
      redirect: "manual",
    });
    const cookie = cookieFrom(res);

    await app.request("/user/logout", { method: "POST", headers: { cookie }, redirect: "manual" });
    const after = await app.request("/", { headers: { cookie }, redirect: "manual" });
    assert.equal(after.status, 302);
    assert.equal(after.headers.get("location"), "/login");
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
    markDownloaded("B000000001", "Author", "Book <One>", "/a.aax");
    ignoreBook("B000000001");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(!html.includes("onclick="), "no inline onclick handlers");
    assert.ok(!/<script(?![^>]*src=)/.test(html), "no inline script blocks");
    assert.ok(html.includes('src="/static/app.js"'), "loads external app.js");
    assert.ok(html.includes("data-action-url"), "actions use data attributes");
  });

  it("escapes book titles in the table", async () => {
    markDownloaded("B000000003", "Author", 'Evil <img src=x onerror=alert(1)> "Book"', "/c.aax");
    const res = await app.request("/");
    const html = await res.text();
    assert.ok(!html.includes("<img src=x"), "raw HTML from title not emitted");
    assert.ok(html.includes("&lt;img src=x"), "title is escaped");
  });
});

// --- User nav discoverability ---

describe("user navigation", () => {
  it("legacy mode shows a sign-in / add-user entry point", async () => {
    const res = await app.request("/");
    const html = await res.text();
    assert.match(html, /class="topbar"/, "topbar rendered without users");
    assert.match(html, /href="\/login"/, "links to the login/add-user page");
    assert.ok(!html.includes("Sign out"), "no session actions in legacy mode");
  });

  it("shows the user menu and settings link once signed in", async () => {
    const add = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "alice" }),
      redirect: "manual",
    });
    const cookie = (add.headers.get("set-cookie") || "").split(";")[0];

    const res = await app.request("/", { headers: { cookie } });
    const html = await res.text();
    assert.match(html, /class="topbar"/);
    assert.match(html, /alice/);
    assert.match(html, /\/user\/settings/);
    assert.match(html, /Sign out/);
  });

  it("keeps the topbar on the settings page", async () => {
    const add = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name: "bob" }),
      redirect: "manual",
    });
    const cookie = (add.headers.get("set-cookie") || "").split(";")[0];

    const res = await app.request("/user/settings", { headers: { cookie } });
    const html = await res.text();
    assert.match(html, /class="topbar"/);
    assert.match(html, /bob/);
  });
});

// --- htmx attribute inheritance regression ---

describe("action buttons are not affected by inherited hx-select", () => {
  it("keeps hx-select off the container that holds the action buttons", async () => {
    const res = await app.request("/");
    const html = await res.text();
    const container = html.match(/<div class="library-layout"[^>]*>/);
    assert.ok(container, "library-layout container present");
    assert.ok(
      !container[0].includes("hx-select"),
      "hx-select on the container is inherited by every action button and " +
        "makes their responses swap in empty content",
    );
  });

  it("still wires up the auto-refresh trigger outside that container", async () => {
    const res = await app.request("/");
    const html = await res.text();
    const refresher = html.match(/<div[^>]*hx-trigger="refresh-books from:body"[^>]*>/);
    assert.ok(refresher, "refresher element present");
    assert.ok(refresher[0].includes('hx-select=".library-layout"'));
    assert.ok(refresher[0].includes('hx-target=".library-layout"'));
  });

  it("sync returns a log panel that references the SSE stream", async () => {
    const res = await app.request("/library/sync", { method: "POST" });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /sse-connect="\/library\/sync\/stream"/);
    assert.match(html, /log-panel/);
  });
});

// --- Audible sign-in from the UI ---

describe("Audible sign-in flow", () => {
  const FAKE_HELPER = `python3 ${path.resolve(import.meta.dirname, "resources", "fake_helper.py")}`;

  async function signedInUser(name: string): Promise<string> {
    const res = await app.request("/user/add", {
      method: "POST",
      body: new URLSearchParams({ name }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") || "").split(";")[0];
  }

  beforeEach(() => {
    process.env.AUDIBLE_HELPER = FAKE_HELPER;
  });

  afterEach(() => {
    delete process.env.AUDIBLE_HELPER;
  });

  it("offers a connect form when not linked", async () => {
    const cookie = await signedInUser("alice");
    const html = await (await app.request("/user/settings", { headers: { cookie } })).text();
    assert.match(html, /Connect Audible/);
    assert.match(html, /\/user\/audible\/start/);
    assert.match(html, /never sees your password/i);
  });

  it("step 1 returns the Amazon URL and the paste form", async () => {
    const cookie = await signedInUser("alice");
    const res = await app.request("/user/audible/start", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ marketplace: "de" }),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /amazon\.de\/ap\/signin/);
    assert.match(html, /step 2 of 2/i);
    assert.match(html, /name="redirect_url"/);
  });

  it("rejects a pasted value that is not a URL", async () => {
    const cookie = await signedInUser("alice");
    await app.request("/user/audible/start", {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ marketplace: "de" }),
    });
    const res = await app.request("/user/audible/complete", {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ redirect_url: "not a url" }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /full address/i);
  });

  it("rejects a URL without an authorization code", async () => {
    const cookie = await signedInUser("alice");
    await app.request("/user/audible/start", {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ marketplace: "de" }),
    });
    const res = await app.request("/user/audible/complete", {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ redirect_url: "https://www.audible.de/" }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /authorization code/i);
  });

  it("completes sign-in and reports the account as connected", async () => {
    const cookie = await signedInUser("alice");
    await app.request("/user/audible/start", {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ marketplace: "de" }),
    });
    const res = await app.request("/user/audible/complete", {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({
        redirect_url: "https://www.audible.de/?openid.oa2.authorization_code=ABC123",
      }),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /connected as Test User/i);

    // status is read back from the user's own config dir
    const after = await (await app.request("/user/settings", { headers: { cookie } })).text();
    assert.match(after, /Connected/);
    assert.match(after, /Reconnect/);
  });

  it("keeps sign-in state separate per user", async () => {
    const alice = await signedInUser("alice");
    const bob = await signedInUser("bob");
    await app.request("/user/audible/start", {
      method: "POST", headers: { cookie: alice },
      body: new URLSearchParams({ marketplace: "de" }),
    });
    await app.request("/user/audible/complete", {
      method: "POST", headers: { cookie: alice },
      body: new URLSearchParams({
        redirect_url: "https://www.audible.de/?openid.oa2.authorization_code=ABC123",
      }),
    });

    const bobHtml = await (await app.request("/user/settings", { headers: { cookie: bob } })).text();
    assert.match(bobHtml, /Connect Audible/, "bob must still be unlinked");
    assert.ok(!/badge-success">Connected/.test(bobHtml));
  });

  it("cancel clears a pending sign-in", async () => {
    const cookie = await signedInUser("alice");
    await app.request("/user/audible/start", {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ marketplace: "de" }),
    });
    const res = await app.request("/user/audible/cancel", { method: "POST", headers: { cookie } });
    const html = await res.text();
    assert.ok(!/step 2 of 2/i.test(html), "pending step must be gone");
    assert.match(html, /Connect Audible/);
  });

  it("explains the CLI fallback when the helper is unavailable", async () => {
    process.env.FAKE_HELPER_MODE = "missing";
    const cookie = await signedInUser("alice");
    const html = await (await app.request("/user/settings", { headers: { cookie } })).text();
    assert.match(html, /audible quickstart/);
    delete process.env.FAKE_HELPER_MODE;
  });
});
