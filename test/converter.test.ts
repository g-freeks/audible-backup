import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Converter, type ChapterInfo, type ChapterData } from "../src/converter.ts";
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

describe("Converter.flattenChapters", () => {
  const converter = createConverter();
  const chapterData: ChapterData = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "resources", "chapters.json"), "utf8"),
  );
  const topLevelChapters = chapterData.content_metadata.chapter_info.chapters;

  it("returns flat chapters as-is", () => {
    const flat: ChapterInfo[] = [
      { length_ms: 1000, start_offset_ms: 0, start_offset_sec: 0, title: "Ch 1" },
      { length_ms: 2000, start_offset_ms: 1000, start_offset_sec: 1, title: "Ch 2" },
    ];
    const result = converter.flattenChapters(flat);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "Ch 1");
    assert.equal(result[1].title, "Ch 2");
  });

  it("expands parent chapters into their subchapters", () => {
    const nested: ChapterInfo[] = [
      {
        length_ms: 100, start_offset_ms: 0, start_offset_sec: 0, title: "Part One",
        chapters: [
          { length_ms: 500, start_offset_ms: 100, start_offset_sec: 0, title: "Ch 1" },
          { length_ms: 600, start_offset_ms: 600, start_offset_sec: 0, title: "Ch 2" },
        ],
      },
    ];
    const result = converter.flattenChapters(nested);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "Ch 1");
    assert.equal(result[1].title, "Ch 2");
  });

  it("handles a mix of flat and nested chapters", () => {
    const mixed: ChapterInfo[] = [
      { length_ms: 100, start_offset_ms: 0, start_offset_sec: 0, title: "Prologue" },
      {
        length_ms: 50, start_offset_ms: 100, start_offset_sec: 0, title: "Part One",
        chapters: [
          { length_ms: 500, start_offset_ms: 150, start_offset_sec: 0, title: "Ch 1" },
        ],
      },
      { length_ms: 200, start_offset_ms: 650, start_offset_sec: 0, title: "Epilogue" },
    ];
    const result = converter.flattenChapters(mixed);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, "Prologue");
    assert.equal(result[1].title, "Ch 1");
    assert.equal(result[2].title, "Epilogue");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(converter.flattenChapters([]), []);
  });

  it("correctly flattens the test fixture chapters.json", () => {
    const result = converter.flattenChapters(topLevelChapters);

    // Top-level flat: Opening Credits, Prologue, Epilogue, Endnote = 4
    // Part One subchapters: Chapter 1, 2, 3 = 3
    // Interludes subchapters: Interlude 1, 2 = 2
    // Part Two subchapters: Chapter 4, 5, 6, 7 = 4
    // Total = 13
    assert.equal(result.length, 13);

    // All results should be leaf chapters (no nested chapters)
    for (const ch of result) {
      assert.equal(ch.chapters, undefined);
    }
  });

  it("preserves chapter order from the fixture", () => {
    const result = converter.flattenChapters(topLevelChapters);
    const titles = result.map((ch) => ch.title);

    assert.deepEqual(titles, [
      "Opening Credits",
      "Prologue",
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Interlude 1",
      "Interlude 2",
      "Chapter 4",
      "Chapter 5",
      "Chapter 6",
      "Chapter 7",
      "Epilogue",
      "Endnote",
    ]);
  });

  it("preserves timing data on flattened subchapters", () => {
    const result = converter.flattenChapters(topLevelChapters);

    // Chapter 1 is the first subchapter of "Part One: The Beginning"
    const ch1 = result.find((ch) => ch.title === "Chapter 1");
    assert.ok(ch1);
    assert.equal(ch1.start_offset_ms, 703982);
    assert.equal(ch1.length_ms, 1912029);

    // Interlude 2 is nested under "Interludes"
    const interlude2 = result.find((ch) => ch.title === "Interlude 2");
    assert.ok(interlude2);
    assert.equal(interlude2.start_offset_ms, 7873376);
    assert.equal(interlude2.length_ms, 575884);
  });

  it("skips parent chapter entries (they have near-zero length_ms)", () => {
    const result = converter.flattenChapters(topLevelChapters);
    const titles = result.map((ch) => ch.title);

    // Parent entries like "Part One", "Interludes", "Part Two" should not appear
    assert.ok(!titles.includes("Part One: The Beginning"));
    assert.ok(!titles.includes("Interludes"));
    assert.ok(!titles.includes("Part Two: The Middle"));
  });
});

describe("Converter.parseTimeMs", () => {
  const converter = createConverter();

  it("parses a typical ffmpeg time string", () => {
    assert.equal(converter.parseTimeMs("01:23:45.67"), 5025670);
  });

  it("parses zero time", () => {
    assert.equal(converter.parseTimeMs("00:00:00.00"), 0);
  });

  it("parses sub-second time", () => {
    assert.equal(converter.parseTimeMs("00:00:00.50"), 500);
  });

  it("returns 0 for invalid input", () => {
    assert.equal(converter.parseTimeMs("invalid"), 0);
  });

  it("handles two-digit centiseconds", () => {
    assert.equal(converter.parseTimeMs("00:01:30.99"), 90990);
  });
});
