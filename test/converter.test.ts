import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Converter } from "../src/converter.ts";
import { closeDb } from "../src/db.ts";

let dbDir: string;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-db-"));
  process.env.DB_PATH = path.join(dbDir, "test.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function createConverter(sourceDir?: string, outputDir?: string): Converter {
  const src = sourceDir || fs.mkdtempSync(path.join(os.tmpdir(), "conv-src-"));
  const out = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), "conv-out-"));
  return new Converter(src, out, "deadbeef");
}

describe("Converter.sanitizeFilename", () => {
  const converter = createConverter();

  it("removes invalid filename characters", () => {
    assert.equal(
      converter.sanitizeFilename('book: the "sequel"'),
      "book the sequel",
    );
  });

  it("normalizes multiple spaces to single space", () => {
    assert.equal(converter.sanitizeFilename("hello    world"), "hello world");
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(converter.sanitizeFilename("  trimmed  "), "trimmed");
  });
});

describe("Converter.formatTime", () => {
  const converter = createConverter();

  it("formats zero milliseconds", () => {
    assert.equal(converter.formatTime(0), "00:00:00");
  });

  it("formats a typical chapter duration", () => {
    assert.equal(converter.formatTime(5025000), "01:23:45");
  });

  it("formats sub-minute duration", () => {
    assert.equal(converter.formatTime(30000), "00:00:30");
  });
});

describe("Converter.getBookDirName", () => {
  const converter = createConverter();

  it("uses book title when provided", () => {
    assert.equal(
      converter.getBookDirName("B001234567", "My Great Book"),
      "My Great Book",
    );
  });

  it("sanitizes the book title", () => {
    assert.equal(
      converter.getBookDirName("B001234567", 'Book: A "Story"'),
      "Book A Story",
    );
  });

  it("falls back to ASIN when title is empty", () => {
    assert.equal(converter.getBookDirName("B001234567", ""), "Book_B001234567");
  });
});

describe("Converter.findBookFiles", () => {
  let tmpDir: string;
  let outDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "find-books-"));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "find-books-out-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("returns empty array when no files exist", () => {
    const converter = new Converter(tmpDir, outDir, "deadbeef");
    assert.deepEqual(converter.findBookFiles(), []);
  });

  it("returns empty when aax exists but chapter json is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "B001234567_title.aax"), "");
    fs.writeFileSync(path.join(tmpDir, "B001234567_title.jpg"), "");
    const converter = new Converter(tmpDir, outDir, "deadbeef");
    assert.deepEqual(converter.findBookFiles(), []);
    fs.unlinkSync(path.join(tmpDir, "B001234567_title.aax"));
    fs.unlinkSync(path.join(tmpDir, "B001234567_title.jpg"));
  });

  it("returns book when all files (aax, chapters json, cover) are present", () => {
    fs.writeFileSync(path.join(tmpDir, "B009876543_MyBook.aax"), "");
    fs.writeFileSync(path.join(tmpDir, "B009876543-chapters.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "B009876543_MyBook.jpg"), "");
    const converter = new Converter(tmpDir, outDir, "deadbeef");
    const books = converter.findBookFiles();
    assert.equal(books.length, 1);
    assert.equal(books[0].asin, "B009876543");
  });
});

describe("Converter constructor", () => {
  it("throws when no activation bytes provided", () => {
    const orig = process.env.AUDIBLE_ACTIVATION_BYTES;
    delete process.env.AUDIBLE_ACTIVATION_BYTES;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conv-"));
    assert.throws(() => new Converter(tmp, tmp, ""), /No activation bytes/);
    process.env.AUDIBLE_ACTIVATION_BYTES = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates output directory if it does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conv-"));
    const outDir = path.join(tmp, "nested", "output");
    new Converter(tmp, outDir, "deadbeef");
    assert.ok(fs.existsSync(outDir));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves tilde in paths", () => {
    const converter = createConverter();
    assert.ok(!converter.sourceDir.includes("~"));
    assert.ok(!converter.outputDir.includes("~"));
  });
});
