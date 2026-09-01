import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  getDb,
  closeDb,
  markDownloaded,
  isDownloaded,
  getDownloadedAsins,
  getAllAudiobooks,
  getAllBooks,
  getAllIgnoredBooks,
  importExistingDownloads,
  ignoreBook,
  unignoreBook,
  isIgnored,
  upsertBook,
  getAudiobookByAsin,
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

describe("isDownloaded", () => {
  it("returns false for unknown ASIN", () => {
    assert.ok(!isDownloaded("B000000000"));
  });

  it("returns true after download", () => {
    markDownloaded("B001234567", "A", "T", "/p.aax");
    assert.ok(isDownloaded("B001234567"));
  });
});

describe("getDownloadedAsins", () => {
  it("returns an empty set for an empty database", () => {
    assert.equal(getDownloadedAsins().size, 0);
  });

  it("returns downloaded ASINs after inserts", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    assert.equal(getDownloadedAsins().size, 2);
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
});

describe("getAllBooks ordering", () => {
  it("sorts downloaded books first, most recently downloaded first", () => {
    const d = getDb();
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    d.prepare("UPDATE audiobooks SET downloaded_at = '2024-01-01T00:00:00' WHERE asin = ?").run("B000000001");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    d.prepare("UPDATE audiobooks SET downloaded_at = '2024-06-01T00:00:00' WHERE asin = ?").run("B000000002");
    const all = getAllBooks();
    assert.deepEqual(all.map((b) => b.asin), ["B000000002", "B000000001"]);
  });

  it("lists not-yet-downloaded books after downloaded ones, alphabetically", () => {
    markDownloaded("B000000001", "A1", "Downloaded Book", "/a.aax");
    upsertBook("B000000002", { author: "A2", title: "Zebra" });
    upsertBook("B000000003", { author: "A3", title: "Alpha" });
    const all = getAllBooks();
    assert.deepEqual(all.map((b) => b.asin), ["B000000001", "B000000003", "B000000002"]);
  });
});

describe("upsertBook metadata", () => {
  it("stores and returns the full metadata set", () => {
    upsertBook("B0934Y5S4Y", {
      author: "Matt Dinniman",
      title: "Carl's Doomsday Scenario",
      narrators: "Jeff Hays",
      releaseDate: "2021-04-22",
      addedToLibraryDate: "2026-08-30T18:01:12.447Z",
      runtimeMinutes: 688,
      language: "english",
      formatType: "unabridged",
      seriesTitle: "Dungeon Crawler Carl",
      seriesSequence: "2",
    });
    const book = getAudiobookByAsin("B0934Y5S4Y");
    assert.ok(book);
    assert.equal(book.narrators, "Jeff Hays");
    assert.equal(book.released_at, "2021-04-22");
    assert.equal(book.added_to_library_at, "2026-08-30T18:01:12.447Z");
    assert.equal(book.runtime_minutes, 688);
    assert.equal(book.language, "english");
    assert.equal(book.format_type, "unabridged");
    assert.equal(book.series_title, "Dungeon Crawler Carl");
    assert.equal(book.series_sequence, "2");
  });

  it("leaves metadata fields null when not provided", () => {
    upsertBook("B000000001", { author: "A", title: "T" });
    const book = getAudiobookByAsin("B000000001");
    assert.equal(book?.narrators, null);
    assert.equal(book?.series_title, null);
    assert.equal(book?.runtime_minutes, null);
  });

  it("updates metadata on conflict, same as author/title", () => {
    upsertBook("B000000001", { author: "A", title: "T", runtimeMinutes: 100 });
    upsertBook("B000000001", { author: "A", title: "T", runtimeMinutes: 200 });
    const book = getAudiobookByAsin("B000000001");
    assert.equal(book?.runtime_minutes, 200);
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

describe("getDownloadedAsins excludes ignored", () => {
  it("does not include ignored books", () => {
    markDownloaded("B000000001", "A1", "T1", "/a.aax");
    markDownloaded("B000000002", "A2", "T2", "/b.aax");
    ignoreBook("B000000001");
    const downloaded = getDownloadedAsins();
    assert.equal(downloaded.size, 1);
    assert.ok(downloaded.has("B000000002"));
    assert.ok(!downloaded.has("B000000001"));
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
