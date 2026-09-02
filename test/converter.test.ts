import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  Converter,
  parseVoucher,
  findConvertedChapters,
  audioEncodeArgs,
  audioArgsString,
  audioExtension,
  tokenizeArgs,
  isAudioFormat,
  isAudioQuality,
  AUDIO_FORMATS,
  AUDIO_QUALITIES,
  AUDIO_PRESETS,
  DEFAULT_AUDIO_SETTINGS,
  renderRow,
  renderDirectorySegments,
  renderFilenameBase,
  bookTagValues,
  getBookDirName,
  DEFAULT_OUTPUT_FORMAT,
  BOOK_TAGS,
  CHAPTER_TAGS,
  type ChapterInfo,
  type ChapterData,
  type OutputFormat,
} from "../src/converter.ts";
import { closeDb, upsertBook, getAudiobookByAsin } from "../src/db.ts";

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

  it("nests folders per a custom directory template, from database metadata", () => {
    upsertBook("B0TEMPLATE1", {
      author: "Brandon Sanderson",
      title: "The Final Empire",
      seriesTitle: "Mistborn",
      seriesSequence: "1",
    });
    const format: OutputFormat = {
      directory: [
        [{ type: "tag", value: "author" }],
        [{ type: "tag", value: "series" }],
        [
          { type: "tag", value: "series" },
          { type: "text", value: " - " },
          { type: "tag", value: "seriesEntry" },
          { type: "text", value: " - " },
          { type: "tag", value: "title" },
        ],
      ],
      filename: DEFAULT_OUTPUT_FORMAT.filename,
    };
    assert.equal(
      getBookDirName("B0TEMPLATE1", "The Final Empire", format),
      path.join("Brandon Sanderson", "Mistborn", "Mistborn - 1 - The Final Empire"),
    );
  });

  it("drops empty folder levels instead of creating empty directories", () => {
    // No series in the database for this one.
    upsertBook("B0NOSERIES1", { author: "Iain M. Banks", title: "Consider Phlebas" });
    const format: OutputFormat = {
      directory: [
        [{ type: "tag", value: "author" }],
        [{ type: "tag", value: "series" }],
        [{ type: "tag", value: "title" }],
      ],
      filename: DEFAULT_OUTPUT_FORMAT.filename,
    };
    assert.equal(
      getBookDirName("B0NOSERIES1", "Consider Phlebas", format),
      path.join("Iain M. Banks", "Consider Phlebas"),
      "the empty {Series} level is skipped, not rendered as an empty folder",
    );
  });

  it("falls back to the ASIN when every level renders empty", () => {
    const format: OutputFormat = {
      directory: [[{ type: "tag", value: "series" }]],
      filename: DEFAULT_OUTPUT_FORMAT.filename,
    };
    assert.equal(
      getBookDirName("B0NOMATCH01", "", format),
      "Book_B0NOMATCH01",
    );
  });

  it("prefers the passed bookTitle over the database row's title", () => {
    upsertBook("B0PREFER001", { author: "A", title: "DB Title" });
    const format: OutputFormat = { directory: [[{ type: "tag", value: "title" }]], filename: DEFAULT_OUTPUT_FORMAT.filename };
    assert.equal(getBookDirName("B0PREFER001", "Fresh Title", format), "Fresh Title");
  });
});

describe("output format templates", () => {
  it("renderRow concatenates tags and literal text in order", () => {
    const row = [
      { type: "tag" as const, value: "author" },
      { type: "text" as const, value: " - " },
      { type: "tag" as const, value: "title" },
    ];
    assert.equal(renderRow(row, { author: "Iain Banks", title: "Consider Phlebas" }), "Iain Banks - Consider Phlebas");
  });

  it("renderRow treats a missing tag value as empty, not literal", () => {
    const row = [{ type: "tag" as const, value: "series" }];
    assert.equal(renderRow(row, {}), "");
  });

  it("renderDirectorySegments sanitizes each level and drops empty ones", () => {
    const format: OutputFormat = {
      directory: [
        [{ type: "tag", value: "author" }],
        [{ type: "tag", value: "series" }],
        [{ type: "tag", value: "title" }],
      ],
      filename: [],
    };
    const segments = renderDirectorySegments(format, {
      author: "A: B",
      series: "",
      title: "Title",
    });
    assert.deepEqual(segments, ["A B", "Title"]);
  });

  it("renderFilenameBase falls back when the whole template renders empty", () => {
    const format: OutputFormat = { directory: [], filename: [{ type: "tag", value: "chapterName" }] };
    assert.equal(renderFilenameBase(format, { chapterName: "" }, "01 - Chapter 01"), "01 - Chapter 01");
  });

  it("renderFilenameBase sanitizes the rendered result", () => {
    const format: OutputFormat = { directory: [], filename: [{ type: "tag", value: "chapterName" }] };
    assert.equal(renderFilenameBase(format, { chapterName: 'A: "Title"' }, "fallback"), "A Title");
  });

  it("bookTagValues pulls every tag from the database row, keyed as the tag catalog expects", () => {
    upsertBook("B0ALLTAGS01", {
      author: "Author Name",
      title: "DB Title",
      narrators: "Narrator Name",
      language: "English",
      seriesTitle: "Series Name",
      seriesSequence: "2",
      releaseDate: "2010-05-01",
    });
    const row = getAudiobookByAsin("B0ALLTAGS01");
    const values = bookTagValues(row, "", "B0ALLTAGS01");
    assert.equal(values.author, "Author Name");
    assert.equal(values.title, "DB Title");
    assert.equal(values.narrator, "Narrator Name");
    assert.equal(values.language, "English");
    assert.equal(values.series, "Series Name");
    assert.equal(values.seriesEntry, "2");
    assert.equal(values.year, "2010");
    assert.equal(values.asin, "B0ALLTAGS01");
  });

  it("bookTagValues degrades gracefully with no database row at all", () => {
    const values = bookTagValues(undefined, "Fallback Title", "B0NOROW001");
    assert.equal(values.title, "Fallback Title");
    assert.equal(values.author, "");
    assert.equal(values.asin, "B0NOROW001");
  });

  it("every advertised tag key actually resolves to a value bookTagValues produces", () => {
    const values = bookTagValues(undefined, "T", "ASIN0000001");
    for (const tag of BOOK_TAGS) {
      assert.ok(tag.key in values, `${tag.key} (${tag.label}) has no corresponding value`);
    }
  });

  it("DEFAULT_OUTPUT_FORMAT's filename template matches the historic '{number} - {name}' layout", () => {
    assert.equal(
      renderRow(DEFAULT_OUTPUT_FORMAT.filename, { chapterNumber: "03", chapterName: "The Escape" }),
      "03 - The Escape",
    );
  });
});

describe("findConvertedChapters", () => {
  it("returns empty array when the output directory doesn't exist", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-fc-out-"));
    assert.deepEqual(findConvertedChapters(outDir, "B001234567", "My Book"), []);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("returns empty array when the book directory has no mp3s", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-fc-out-"));
    fs.mkdirSync(path.join(outDir, "My Book"));
    fs.writeFileSync(path.join(outDir, "My Book", "cover.jpg"), "");
    assert.deepEqual(findConvertedChapters(outDir, "B001234567", "My Book"), []);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("lists mp3 chapter files when present", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-fc-out-"));
    fs.mkdirSync(path.join(outDir, "My Book"));
    fs.writeFileSync(path.join(outDir, "My Book", "01 - Ch 1.mp3"), "");
    fs.writeFileSync(path.join(outDir, "My Book", "02 - Ch 2.mp3"), "");
    fs.writeFileSync(path.join(outDir, "My Book", "My Book.jpg"), "");
    const chapters = findConvertedChapters(outDir, "B001234567", "My Book");
    assert.equal(chapters.length, 2);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("falls back to the ASIN-based directory when title is empty", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-fc-out-"));
    fs.mkdirSync(path.join(outDir, "Book_B001234567"));
    fs.writeFileSync(path.join(outDir, "Book_B001234567", "01 - Ch 1.mp3"), "");
    assert.equal(findConvertedChapters(outDir, "B001234567", "").length, 1);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("recognizes flac and m4a chapters too, not just mp3", () => {
    // A book converted before a later format switch must still read as
    // converted — status detection isn't tied to whichever format is
    // currently selected.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-fc-out-"));
    fs.mkdirSync(path.join(outDir, "My Book"));
    fs.writeFileSync(path.join(outDir, "My Book", "01 - Ch 1.flac"), "");
    fs.writeFileSync(path.join(outDir, "My Book", "02 - Ch 2.m4a"), "");
    fs.writeFileSync(path.join(outDir, "My Book", "cover.jpg"), "");
    assert.equal(findConvertedChapters(outDir, "B001234567", "My Book").length, 2);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("looks inside a nested folder when given a multi-level directory template", () => {
    upsertBook("B0NESTED001", { author: "Iain M. Banks", title: "Consider Phlebas" });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-fc-out-"));
    const nested = path.join(outDir, "Iain M. Banks", "Consider Phlebas");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "01 - Ch 1.mp3"), "");

    const format: OutputFormat = {
      directory: [[{ type: "tag", value: "author" }], [{ type: "tag", value: "title" }]],
      filename: DEFAULT_OUTPUT_FORMAT.filename,
    };
    assert.equal(
      findConvertedChapters(outDir, "B0NESTED001", "Consider Phlebas", format).length,
      1,
    );
    fs.rmSync(outDir, { recursive: true, force: true });
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

  it("returns aaxc book only when its voucher is present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-aaxc-"));
    fs.writeFileSync(path.join(dir, "B0AAXC0001_Book.aaxc"), "");
    fs.writeFileSync(path.join(dir, "B0AAXC0001-chapters.json"), "{}");
    fs.writeFileSync(path.join(dir, "B0AAXC0001_(500).jpg"), "");
    const converter = new Converter(dir, outDir, "");
    assert.deepEqual(converter.findBookFiles(), [], "no voucher -> not convertible");

    fs.writeFileSync(path.join(dir, "B0AAXC0001_Book.voucher"), "{}");
    const books = converter.findBookFiles();
    assert.equal(books.length, 1);
    assert.equal(books[0].asin, "B0AAXC0001");
    assert.ok(books[0].aaxFile.endsWith(".aaxc"));
    assert.ok(books[0].voucherFile?.endsWith(".voucher"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("AAXC vouchers", () => {
  it("parses the helper's flat voucher format", () => {
    const voucher = parseVoucher(JSON.stringify({ key: "k".repeat(32), iv: "i".repeat(32) }));
    assert.equal(voucher.key, "k".repeat(32));
    assert.equal(voucher.iv, "i".repeat(32));
  });

  it("parses audible-cli's nested voucher format", () => {
    const voucher = parseVoucher(
      JSON.stringify({
        content_license: { license_response: { key: "abc", iv: "def", rules: [] } },
      }),
    );
    assert.equal(voucher.key, "abc");
    assert.equal(voucher.iv, "def");
  });

  it("rejects vouchers without key/iv", () => {
    assert.throws(() => parseVoucher("{}"), /key\/iv/);
    assert.throws(() => parseVoucher('{"content_license":{}}'), /key\/iv/);
  });

  it("builds ffmpeg decrypt args from a voucher for .aaxc", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-va-"));
    const voucherFile = path.join(dir, "b.voucher");
    fs.writeFileSync(voucherFile, JSON.stringify({ key: "aa", iv: "bb" }));
    const converter = new Converter(dir, dir, "");
    assert.deepEqual(converter.decryptArgs("book.aaxc", voucherFile), [
      "-audible_key", "aa", "-audible_iv", "bb",
    ]);
    assert.throws(() => converter.decryptArgs("book.aaxc"), /No voucher/);
    assert.deepEqual(new Converter(dir, dir, "deadbeef").decryptArgs("book.aax"), [
      "-activation_bytes", "deadbeef",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Converter constructor", () => {
  it("allows empty activation bytes (only needed for legacy .aax at convert time)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conv-"));
    const converter = new Converter(tmp, tmp, "");
    assert.throws(() => converter.decryptArgs("book.aax"), /No activation bytes/);
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

  it("defaults to mp3/medium when no audio settings are given", () => {
    const converter = createConverter();
    assert.deepEqual(converter.audioSettings, DEFAULT_AUDIO_SETTINGS);
  });

  it("stores explicit audio settings", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "conv-src-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "conv-out-"));
    const converter = new Converter(src, out, "deadbeef", undefined, false, {
      format: "flac",
      quality: "high",
    });
    assert.deepEqual(converter.audioSettings, { format: "flac", quality: "high" });
  });
});

describe("audio quality presets", () => {
  it("covers every format/quality combination with args and an estimate", () => {
    for (const format of AUDIO_FORMATS) {
      for (const quality of AUDIO_QUALITIES) {
        const preset = AUDIO_PRESETS[format][quality];
        assert.ok(preset.args.length > 0, `${format}/${quality} has encode args`);
        assert.match(preset.estimate, /hour/i, `${format}/${quality} has a per-hour estimate`);
      }
    }
  });

  it("resolves preset args from format + quality", () => {
    assert.deepEqual(
      audioEncodeArgs({ format: "mp3", quality: "low" }),
      AUDIO_PRESETS.mp3.low.args,
    );
    assert.deepEqual(
      audioEncodeArgs({ format: "aac", quality: "high" }),
      AUDIO_PRESETS.aac.high.args,
    );
  });

  it("prefers custom args over the preset when set", () => {
    const settings = { format: "mp3" as const, quality: "low" as const, customArgs: "-c:a libmp3lame -q:a 0" };
    assert.deepEqual(audioEncodeArgs(settings), ["-c:a", "libmp3lame", "-q:a", "0"]);
    assert.equal(audioArgsString(settings), "-c:a libmp3lame -q:a 0");
  });

  it("ignores blank custom args and falls back to the preset", () => {
    const settings = { format: "mp3" as const, quality: "medium" as const, customArgs: "   " };
    assert.deepEqual(audioEncodeArgs(settings), AUDIO_PRESETS.mp3.medium.args);
  });

  it("renders the preset as a plain string when there is no custom override", () => {
    assert.equal(
      audioArgsString({ format: "mp3", quality: "medium" }),
      AUDIO_PRESETS.mp3.medium.args.join(" "),
    );
  });

  it("maps AAC to an .m4a extension for container/metadata compatibility, others to themselves", () => {
    assert.equal(audioExtension("mp3"), "mp3");
    assert.equal(audioExtension("flac"), "flac");
    assert.equal(audioExtension("aac"), "m4a");
  });
});

describe("tokenizeArgs", () => {
  it("splits plain whitespace-separated args", () => {
    assert.deepEqual(tokenizeArgs("-c:a libmp3lame -b:a 128k"), ["-c:a", "libmp3lame", "-b:a", "128k"]);
  });

  it("respects double and single quoted segments", () => {
    assert.deepEqual(
      tokenizeArgs(`-metadata title="My Book" -metadata artist='Jane Doe'`),
      ["-metadata", "title=My Book", "-metadata", "artist=Jane Doe"],
    );
  });

  it("collapses extra whitespace and ignores empty input", () => {
    assert.deepEqual(tokenizeArgs("  -c:a   flac  "), ["-c:a", "flac"]);
    assert.deepEqual(tokenizeArgs(""), []);
  });
});

describe("isAudioFormat / isAudioQuality", () => {
  it("accepts only the known values", () => {
    assert.equal(isAudioFormat("mp3"), true);
    assert.equal(isAudioFormat("flac"), true);
    assert.equal(isAudioFormat("aac"), true);
    assert.equal(isAudioFormat("wav"), false);
    assert.equal(isAudioFormat(undefined), false);
    assert.equal(isAudioFormat(42), false);

    assert.equal(isAudioQuality("low"), true);
    assert.equal(isAudioQuality("medium"), true);
    assert.equal(isAudioQuality("high"), true);
    assert.equal(isAudioQuality("ultra"), false);
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
