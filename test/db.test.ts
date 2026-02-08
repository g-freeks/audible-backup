import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getDb,
  closeDb,
  markDownloaded,
  markConverted,
  isDownloaded,
  isConverted,
  getDownloadedAsins,
  getConvertedAsins,
  getAllAudiobooks,
  getAllIgnoredBooks,
  importExistingDownloads,
  ignoreBook,
  unignoreBook,
  isIgnored,
} from "../src/db.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-test-"));
  process.env.DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getDb", () => {
  it("creates database and audiobooks table", () => {
    const db = getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='audiobooks'",
      )
      .all() as { name: string }[];
    assert.equal(tables.length, 1);
  });

  it("returns the same instance on subsequent calls", () => {
    const db1 = getDb();
    const db2 = getDb();
    assert.equal(db1, db2);
  });

  it("creates a new instance after closeDb", () => {
    const db1 = getDb();
    closeDb();
    const db2 = getDb();
    assert.notEqual(db1, db2);
  });
});

describe("markDownloaded", () => {
  it("inserts a new audiobook record", () => {
    markDownloaded("B001234567", "Author A", "Title A", "/path/to/file.aax");
    assert.ok(isDownloaded("B001234567"));
  });

  it("updates existing record on conflict", () => {
    markDownloaded("B001234567", "Author A", "Title A", "/path/a.aax");
    markDownloaded("B001234567", "Author B", "Title B", "/path/b.aax");
    const all = getAllAudiobooks();
    const book = all.find((b) => b.asin === "B001234567");
    assert.equal(book?.author, "Author B");
    assert.equal(book?.aax_path, "/path/b.aax");
  });

  it("sets downloaded_at timestamp", () => {
    markDownloaded("B001234567", "Author", "Title", "/path/file.aax");
    const all = getAllAudiobooks();
    assert.ok(all[0].downloaded_at);
  });
});

describe("markConverted", () => {
  it("updates conversion fields on an existing record", () => {
    markDownloaded("B001234567", "Author", "Title", "/path/file.aax");
    markConverted("B001234567", "/output/dir", 15);
    assert.ok(isConverted("B001234567"));
    const all = getAllAudiobooks();
    assert.equal(all[0].output_path, "/output/dir");
    assert.equal(all[0].chapter_count, 15);
  });

  it("does nothing for nonexistent ASIN", () => {
    markConverted("ZZZZZZZZZZ", "/output/dir", 5);
    assert.ok(!isConverted("ZZZZZZZZZZ"));
  });
});

describe("isDownloaded / isConverted", () => {
  it("returns false for unknown ASIN", () => {
    assert.ok(!isDownloaded("B000000000"));
    assert.ok(!isConverted("B000000000"));
  });

  it("isConverted returns false for downloaded-only book", () => {
    markDownloaded("B001234567", "A", "T", "/p.aax");
    assert.ok(!isConverted("B001234567"));
  });

  it("both return true after download and conversion", () => {
    markDownloaded("B001234567", "A", "T", "/p.aax");
    markConverted("B001234567", "/out", 10);
    assert.ok(isDownloaded("B001234567"));
    assert.ok(isConverted("B001234567"));
  });
});

describe("getDownloadedAsins / getConvertedAsins", () => {
  it("returns empty sets for empty database", () => {
    assert.equal(getDownloadedAsins().size, 0);
    assert.equal(getConvertedAsins().size, 0);
  });

  it("returns correct sets after multiple inserts", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    markConverted("B000000001", "/out", 5);
    assert.equal(getDownloadedAsins().size, 2);
    assert.equal(getConvertedAsins().size, 1);
  });
});

describe("getAllAudiobooks", () => {
  it("returns all records", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    const all = getAllAudiobooks();
    assert.equal(all.length, 2);
    const asins = all.map((r) => r.asin).sort();
    assert.deepEqual(asins, ["B000000001", "B000000002"]);
  });

  it("includes conversion data when present", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markConverted("B000000001", "/out/dir", 12);
    const all = getAllAudiobooks();
    assert.equal(all[0].chapter_count, 12);
    assert.ok(all[0].converted_at);
  });
});

describe("importExistingDownloads", () => {
  it("imports new ASINs into database", () => {
    const asins = new Map([
      ["B000000001", "/path/B000000001.aax"],
      ["B000000002", "/path/B000000002.aax"],
    ]);
    const count = importExistingDownloads(asins);
    assert.equal(count, 2);
    assert.ok(isDownloaded("B000000001"));
    assert.ok(isDownloaded("B000000002"));
  });

  it("skips already-existing ASINs", () => {
    markDownloaded("B000000001", "Existing", "Book", "/old.aax");
    const asins = new Map([
      ["B000000001", "/new/path.aax"],
      ["B000000002", "/path/B000000002.aax"],
    ]);
    const count = importExistingDownloads(asins);
    assert.equal(count, 1);
    const all = getAllAudiobooks();
    const book = all.find((b) => b.asin === "B000000001");
    assert.equal(book?.author, "Existing");
  });

  it("returns 0 for empty map", () => {
    assert.equal(importExistingDownloads(new Map()), 0);
  });
});

describe("ignoreBook / unignoreBook / isIgnored", () => {
  it("ignores a book by ASIN", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    assert.ok(!isIgnored("B000000001"));
    ignoreBook("B000000001");
    assert.ok(isIgnored("B000000001"));
  });

  it("unignores a previously ignored book", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    ignoreBook("B000000001");
    assert.ok(isIgnored("B000000001"));
    unignoreBook("B000000001");
    assert.ok(!isIgnored("B000000001"));
  });

  it("ignoreBook upserts for unknown ASIN", () => {
    ignoreBook("B099999999");
    assert.ok(isIgnored("B099999999"));
  });

  it("unignoreBook is a no-op for unknown ASIN", () => {
    unignoreBook("B099999999");
    assert.ok(!isIgnored("B099999999"));
  });
});

describe("getAllAudiobooks excludes ignored", () => {
  it("does not return ignored books", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    ignoreBook("B000000001");
    const all = getAllAudiobooks();
    assert.equal(all.length, 1);
    assert.equal(all[0].asin, "B000000002");
  });
});

describe("getDownloadedAsins / getConvertedAsins exclude ignored", () => {
  it("getDownloadedAsins excludes ignored books", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    ignoreBook("B000000001");
    const downloaded = getDownloadedAsins();
    assert.equal(downloaded.size, 1);
    assert.ok(downloaded.has("B000000002"));
    assert.ok(!downloaded.has("B000000001"));
  });

  it("getConvertedAsins excludes ignored books", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markConverted("B000000001", "/out", 5);
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    markConverted("B000000002", "/out2", 3);
    ignoreBook("B000000001");
    const converted = getConvertedAsins();
    assert.equal(converted.size, 1);
    assert.ok(converted.has("B000000002"));
  });
});

describe("getAllIgnoredBooks", () => {
  it("returns only ignored books", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    ignoreBook("B000000001");
    const ignored = getAllIgnoredBooks();
    assert.equal(ignored.length, 1);
    assert.equal(ignored[0].asin, "B000000001");
  });

  it("returns empty array when nothing is ignored", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    const ignored = getAllIgnoredBooks();
    assert.equal(ignored.length, 0);
  });
});
