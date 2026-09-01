import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.ts";
import { getIgnoredAsins, getAudiobookByAsin } from "./db.ts";
import { type ProgressReporter, consoleReporter } from "./progress.ts";
import { operationSignal } from "./operations.ts";

export interface ChapterInfo {
  length_ms: number;
  start_offset_ms: number;
  start_offset_sec: number;
  title: string;
  chapters?: ChapterInfo[];
}

export interface ChapterData {
  content_metadata: {
    chapter_info: {
      brandIntroDurationMs?: number;
      brandOutroDurationMs?: number;
      chapters: ChapterInfo[];
      is_accurate: boolean;
      runtime_length_ms: number;
      runtime_length_sec: number;
    };
    content_reference: {
      asin: string;
      [key: string]: any;
    };
    [key: string]: any;
  };
}

export interface BookFiles {
  aaxFile: string;
  chapterFile: string;
  asin: string;
  bookTitle: string;
  bookCover: string;
  /** Decryption voucher (key/iv), present for .aaxc files. */
  voucherFile?: string;
}

export interface AaxcVoucher {
  key: string;
  iv: string;
}

/**
 * Parse an AAXC voucher file. Accepts both the flat format written by our
 * Python helper ({key, iv}) and audible-cli's nested .voucher format
 * ({content_license: {license_response: {key, iv}}}).
 */
export function parseVoucher(json: string): AaxcVoucher {
  const data = JSON.parse(json);
  const nested = data?.content_license?.license_response;
  const key = data?.key ?? nested?.key;
  const iv = data?.iv ?? nested?.iv;
  if (typeof key !== "string" || typeof iv !== "string" || !key || !iv) {
    throw new Error("Voucher file has no usable key/iv");
  }
  return { key, iv };
}

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getBookDirName(asin: string, bookTitle: string): string {
  if (bookTitle) {
    return sanitizeFilename(bookTitle);
  }
  return sanitizeFilename(`Book_${asin}`);
}

/**
 * A book's own asin+title deterministically names its output directory
 * (see getBookDirName), so "is this converted" is a direct filesystem check
 * against a known path rather than a stored DB flag — no title-matching
 * against unknown files involved.
 */
/** Extensions any supported output format's chapter files can end in — kept
 * broad (not just the current format) so a book converted before a format
 * change still reads as converted. */
const AUDIO_EXTENSIONS = ["mp3", "flac", "m4a"];

export function findConvertedChapters(
  outputDir: string,
  asin: string,
  title: string,
): string[] {
  const bookDir = path.join(outputDir, getBookDirName(asin, title));
  if (!fs.existsSync(bookDir)) return [];
  return fs.readdirSync(bookDir).filter((f) =>
    AUDIO_EXTENSIONS.some((ext) => f.endsWith(`.${ext}`)),
  );
}

// --- Audio quality settings ---
//
// Presets map (format, quality) to the ffmpeg args that encode the decrypted
// audio, plus a rough "MB per hour of runtime" shown as a tooltip in the
// settings UI. A user can override the derived args string entirely instead
// (customArgs) — still just an argv array handed to `spawn`, never a shell,
// so there is no shell-injection surface regardless of its contents.

export type AudioFormat = "mp3" | "flac" | "aac";
export type AudioQuality = "low" | "medium" | "high";

export const AUDIO_FORMATS: AudioFormat[] = ["mp3", "flac", "aac"];
export const AUDIO_QUALITIES: AudioQuality[] = ["low", "medium", "high"];

export function isAudioFormat(v: unknown): v is AudioFormat {
  return typeof v === "string" && (AUDIO_FORMATS as string[]).includes(v);
}

export function isAudioQuality(v: unknown): v is AudioQuality {
  return typeof v === "string" && (AUDIO_QUALITIES as string[]).includes(v);
}

export interface AudioSettings {
  format: AudioFormat;
  quality: AudioQuality;
  /** Raw ffmpeg audio-encode args (e.g. "-c:a libmp3lame -b:a 128k"),
   * overriding the format/quality preset when set. */
  customArgs?: string;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = { format: "mp3", quality: "medium" };

interface AudioPreset {
  args: string[];
  /** Shown as a tooltip on the quality buttons — spoken-word audio, roughly. */
  estimate: string;
}

export const AUDIO_PRESETS: Record<AudioFormat, Record<AudioQuality, AudioPreset>> = {
  mp3: {
    low: { args: ["-c:a", "libmp3lame", "-b:a", "64k"], estimate: "~28 MB per hour of runtime" },
    medium: { args: ["-c:a", "libmp3lame", "-b:a", "128k"], estimate: "~58 MB per hour of runtime" },
    high: { args: ["-c:a", "libmp3lame", "-b:a", "256k"], estimate: "~115 MB per hour of runtime" },
  },
  aac: {
    low: { args: ["-c:a", "aac", "-b:a", "48k"], estimate: "~22 MB per hour of runtime" },
    medium: { args: ["-c:a", "aac", "-b:a", "96k"], estimate: "~43 MB per hour of runtime" },
    high: { args: ["-c:a", "aac", "-b:a", "192k"], estimate: "~86 MB per hour of runtime" },
  },
  flac: {
    low: {
      args: ["-c:a", "flac", "-compression_level", "1"],
      estimate: "~350–400 MB per hour (lossless — size depends on the source; this only trades encode speed)",
    },
    medium: {
      args: ["-c:a", "flac", "-compression_level", "5"],
      estimate: "~350–400 MB per hour (lossless — size depends on the source; this only trades encode speed)",
    },
    high: {
      args: ["-c:a", "flac", "-compression_level", "8"],
      estimate: "~350–400 MB per hour (lossless — slowest, marginally smallest)",
    },
  },
};

/** File extension the format encodes to — AAC goes in an .m4a container for
 * broad player compatibility and proper metadata tag support. */
export function audioExtension(format: AudioFormat): string {
  return format === "aac" ? "m4a" : format;
}

/** Minimal shell-like tokenizer: splits on whitespace, but a single- or
 * double-quoted run (even mid-token, e.g. `title="My Book"`) keeps its
 * contents — including spaces — together as one argument, with the quotes
 * themselves stripped. No escaping, globbing or variable expansion. Only
 * decides argv boundaries for a user-edited args string — it is never passed
 * through a shell, so this cannot introduce a shell-injection surface. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** The actual ffmpeg args this settings object encodes to. */
export function audioEncodeArgs(settings: AudioSettings): string[] {
  if (settings.customArgs?.trim()) return tokenizeArgs(settings.customArgs);
  return AUDIO_PRESETS[settings.format][settings.quality].args;
}

/** What the settings UI shows (and lets the user hand-edit) for these
 * settings — the custom string verbatim, or the preset rendered as text. */
export function audioArgsString(settings: AudioSettings): string {
  if (settings.customArgs?.trim()) return settings.customArgs.trim();
  return AUDIO_PRESETS[settings.format][settings.quality].args.join(" ");
}

export class Converter {
  sourceDir: string;
  outputDir: string;
  activationBytes: string;
  force: boolean;
  audioSettings: AudioSettings;
  private reporter: ProgressReporter;

  constructor(
    sourceDir: string = config.targetDir,
    outputDir: string = config.outputDir,
    activationBytes: string = config.activationBytes,
    reporter: ProgressReporter = consoleReporter,
    force: boolean = false,
    audioSettings: AudioSettings = DEFAULT_AUDIO_SETTINGS,
  ) {
    this.reporter = reporter;
    this.force = force;
    this.sourceDir = path.resolve(
      sourceDir.replace("~", process.env.HOME || ""),
    );
    this.outputDir = path.resolve(
      outputDir.replace("~", process.env.HOME || ""),
    );
    // Activation bytes are only needed for legacy .aax files — .aaxc books
    // carry their own per-file voucher. Checked per book at convert time.
    this.activationBytes = activationBytes;
    this.audioSettings = audioSettings;

    this.ensureOutputDirectory();
  }

  ensureOutputDirectory(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
      this.reporter.log(`Created output directory: ${this.outputDir}`);
    }
  }

  sanitizeFilename(filename: string): string {
    return sanitizeFilename(filename);
  }

  flattenChapters(chapters: ChapterInfo[]): ChapterInfo[] {
    const result: ChapterInfo[] = [];
    for (const chapter of chapters) {
      if (chapter.chapters && chapter.chapters.length > 0) {
        result.push(...this.flattenChapters(chapter.chapters));
      } else {
        result.push(chapter);
      }
    }
    return result;
  }

  formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  parseTimeMs(timeStr: string): number {
    const m = timeStr.match(/(\d+):(\d+):(\d+)\.(\d+)/);
    if (!m) return 0;
    return (
      parseInt(m[1]) * 3600000 +
      parseInt(m[2]) * 60000 +
      parseInt(m[3]) * 1000 +
      parseInt(m[4].padEnd(3, "0").slice(0, 3))
    );
  }

  /** ffmpeg input decryption args: voucher key/iv for .aaxc, activation bytes for .aax. */
  decryptArgs(aaxFile: string, voucherFile?: string): string[] {
    if (aaxFile.endsWith(".aaxc")) {
      if (!voucherFile) {
        throw new Error(`No voucher file for ${path.basename(aaxFile)}`);
      }
      const voucher = parseVoucher(fs.readFileSync(voucherFile, "utf8"));
      return ["-audible_key", voucher.key, "-audible_iv", voucher.iv];
    }
    if (!this.activationBytes) {
      throw new Error(
        "No activation bytes provided. Set AUDIBLE_ACTIVATION_BYTES in .env or in the user's settings.",
      );
    }
    return ["-activation_bytes", this.activationBytes];
  }

  async convertAaxToAudio(aaxFile: string, outputFile: string, totalDurationMs?: number, asin?: string, voucherFile?: string): Promise<boolean> {
    let inputArgs: string[];
    try {
      inputArgs = this.decryptArgs(aaxFile, voucherFile);
    } catch (error) {
      this.reporter.error(String(error instanceof Error ? error.message : error));
      return false;
    }

    return new Promise((resolve) => {
      this.reporter.log(`Converting ${path.basename(aaxFile)} to ${this.audioSettings.format.toUpperCase()}`);

      const ffmpegProcess = spawn(
        "ffmpeg",
        [
          ...inputArgs,
          "-i",
          aaxFile,
          "-vn",
          ...audioEncodeArgs(this.audioSettings),
          "-y",
          outputFile,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          signal: operationSignal(),
        },
      );

      let stderr = "";
      let lastPct = -1;
      ffmpegProcess.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;

        if (totalDurationMs && totalDurationMs > 0) {
          const timeMatch = chunk.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (timeMatch) {
            const currentMs = this.parseTimeMs(timeMatch[1]);
            const pct = Math.min(100, Math.round((currentMs / totalDurationMs) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              this.reporter.progress?.(pct, "Converting");
              // Scale to 0-90% for per-book progress (splitting is 90-100%)
              if (asin) {
                this.reporter.bookProgress?.(asin, Math.round(pct * 0.9));
              }
            }
          }
        }
      });

      ffmpegProcess.on("close", (code) => {
        if (totalDurationMs && totalDurationMs > 0 && lastPct < 100 && code === 0) {
          this.reporter.progress?.(100, "Converting");
        }
        if (code === 0) {
          this.reporter.log(
            `Successfully converted: ${path.basename(outputFile)}`,
          );
          resolve(true);
        } else {
          this.reporter.error(
            `Failed to convert ${path.basename(aaxFile)} (exit code: ${code})`,
          );
          if (stderr) {
            this.reporter.error(`FFmpeg error: ${stderr.slice(-500)}`);
          }
          resolve(false);
        }
      });

      ffmpegProcess.on("error", (error) => {
        this.reporter.error(
          `Error converting ${path.basename(aaxFile)}: ${error.message}`,
        );
        resolve(false);
      });
    });
  }

  async splitIntoChapters(
    sourceFile: string,
    chapterData: ChapterData,
    bookDir: string,
    asin?: string,
    tags?: { album?: string; artist?: string },
  ): Promise<boolean> {
    const chapters = this.flattenChapters(chapterData.content_metadata.chapter_info.chapters);
    const ext = audioExtension(this.audioSettings.format);

    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
    }

    this.reporter.log(`Splitting into ${chapters.length} chapters...`);

    let successCount = 0;
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const chapterNumber = (i + 1).toString().padStart(2, "0");
      const chapterTitle = this.sanitizeFilename(
        chapter.title || `Chapter ${chapterNumber}`,
      );
      const outputFile = path.join(
        bookDir,
        `${chapterNumber} - ${chapterTitle}.${ext}`,
      );

      const splitPct = Math.round(((i + 1) / chapters.length) * 100);

      if (fs.existsSync(outputFile)) {
        this.reporter.log(
          `  [${i + 1}/${chapters.length}] Skipping existing: ${chapterTitle}`,
        );
        successCount++;
        this.reporter.progress?.(splitPct, "Splitting chapters");
        if (asin) {
          this.reporter.bookProgress?.(asin, 90 + Math.round(splitPct * 0.1));
        }
        continue;
      }

      this.reporter.log(
        `  [${i + 1}/${chapters.length}] Splitting: ${chapterTitle}`,
      );
      const success = await this.splitChapter(sourceFile, outputFile, chapter, {
        title: chapterTitle,
        track: `${i + 1}/${chapters.length}`,
        album: tags?.album,
        artist: tags?.artist,
      });
      if (success) {
        successCount++;
      }
      this.reporter.progress?.(splitPct, "Splitting chapters");
      if (asin) {
        this.reporter.bookProgress?.(asin, 90 + Math.round(splitPct * 0.1));
      }
    }

    this.reporter.log(
      `Chapter splitting complete: ${successCount}/${chapters.length} chapters`,
    );
    return successCount === chapters.length;
  }

  async splitChapter(
    inputFile: string,
    outputFile: string,
    chapter: ChapterInfo,
    tags?: { title?: string; track?: string; album?: string; artist?: string },
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = this.formatTime(chapter.start_offset_ms);
      const duration = this.formatTime(chapter.length_ms);

      const metadataArgs: string[] = [];
      if (tags) {
        for (const [key, value] of Object.entries(tags)) {
          if (value) metadataArgs.push("-metadata", `${key}=${value}`);
        }
        // ID3v2 versioning is an MP3-muxer-specific option; FLAC/M4A tag
        // their own way and don't recognize this flag.
        if (metadataArgs.length > 0 && this.audioSettings.format === "mp3") {
          metadataArgs.push("-id3v2_version", "3");
        }
      }

      const ffmpegProcess = spawn(
        "ffmpeg",
        [
          "-i",
          inputFile,
          "-ss",
          startTime,
          "-t",
          duration,
          "-c",
          "copy",
          ...metadataArgs,
          "-y",
          outputFile,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          signal: operationSignal(),
        },
      );

      let stderr = "";
      ffmpegProcess.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpegProcess.on("close", (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          this.reporter.error(
            `Failed to create chapter: ${path.basename(outputFile)} (exit code: ${code})`,
          );
          if (stderr) {
            this.reporter.error(`FFmpeg error: ${stderr.slice(-200)}`);
          }
          resolve(false);
        }
      });

      ffmpegProcess.on("error", (error) => {
        this.reporter.error(
          `Error creating chapter ${path.basename(outputFile)}: ${error.message}`,
        );
        resolve(false);
      });
    });
  }

  findBookFiles(): BookFiles[] {
    const files = fs.readdirSync(this.sourceDir, { withFileTypes: true });
    const bookMap = new Map<
      string,
      {
        aaxFile?: string;
        chapterFile?: string;
        bookTitle?: string;
        bookCover?: string;
        voucherFile?: string;
      }
    >();

    for (const file of files) {
      if (file.isFile()) {
        const fullPath = path.join(file.parentPath, file.name);
        const asinMatch = file.name.match(/([A-Z0-9]{10})/);

        if (asinMatch) {
          const asin = asinMatch[1];
          if (!bookMap.has(asin)) {
            bookMap.set(asin, {});
          }

          const bookEntry = bookMap.get(asin)!;

          if (file.name.endsWith(".aax") || file.name.endsWith(".aaxc")) {
            bookEntry.aaxFile = fullPath;
            const baseName = file.name.replace(/\.aaxc?$/, "");
            bookEntry.bookTitle = baseName
              .split("-LC_")[0]
              .replace(asin, "")
              .replace(/[_\s]+/g, " ")
              .trim();
          } else if (file.name.endsWith(".voucher")) {
            bookEntry.voucherFile = fullPath;
          } else if (file.name.endsWith(".jpg")) {
            bookEntry.bookCover = fullPath;
          } else if (file.name.endsWith("-chapters.json")) {
            bookEntry.chapterFile = fullPath;
          }
        }
      }
    }

    const completeBooks: BookFiles[] = [];
    for (const [asin, files] of bookMap) {
      const isAaxc = files.aaxFile?.endsWith(".aaxc") ?? false;
      if (
        files.aaxFile &&
        files.chapterFile &&
        files.bookCover &&
        (!isAaxc || files.voucherFile)
      ) {
        completeBooks.push({
          aaxFile: files.aaxFile,
          chapterFile: files.chapterFile,
          asin,
          bookTitle: files.bookTitle || "",
          bookCover: files.bookCover,
          voucherFile: files.voucherFile,
        });
      }
    }

    return completeBooks;
  }

  getBookDirName(asin: string, bookTitle: string): string {
    return getBookDirName(asin, bookTitle);
  }

  async convertBook(
    aaxFile: string,
    chapterFile: string,
    asin: string,
    bookTitle: string,
    bookCover: string,
    voucherFile?: string,
  ): Promise<boolean> {
    this.reporter.log(`\nProcessing book: ${asin}`);
    this.reporter.bookStart?.(asin);

    if (!this.force && findConvertedChapters(this.outputDir, asin, bookTitle).length > 0) {
      this.reporter.log(
        `Book already converted (output files exist): ${bookTitle || asin}`,
      );
      this.reporter.bookDone?.(asin, true);
      return true;
    }

    try {
      const chapterData: ChapterData = JSON.parse(
        fs.readFileSync(chapterFile, "utf8"),
      );

      const bookDirName = this.getBookDirName(asin, bookTitle);
      const bookDir = path.join(this.outputDir, bookDirName);

      const tempAudio = path.join(
        this.outputDir,
        `temp_${asin}.${audioExtension(this.audioSettings.format)}`,
      );
      const totalDurationMs = chapterData.content_metadata.chapter_info.runtime_length_ms;

      const conversionSuccess = await this.convertAaxToAudio(aaxFile, tempAudio, totalDurationMs, asin, voucherFile);
      if (!conversionSuccess) {
        this.reporter.bookDone?.(asin, false);
        return false;
      }

      const author = getAudiobookByAsin(asin)?.author || undefined;
      const splittingSuccess = await this.splitIntoChapters(
        tempAudio,
        chapterData,
        bookDir,
        asin,
        { album: bookTitle || undefined, artist: author },
      );

      if (fs.existsSync(bookCover)) {
        fs.copyFileSync(bookCover, path.join(bookDir, `${bookDirName}.jpg`));
      }

      if (fs.existsSync(tempAudio)) {
        fs.unlinkSync(tempAudio);
        this.reporter.log("Cleaned up temporary file");
      }

      if (splittingSuccess) {
        this.reporter.log(`Successfully processed: ${bookDirName}`);
      }

      this.reporter.bookDone?.(asin, splittingSuccess);
      return splittingSuccess;
    } catch (error) {
      this.reporter.error(`Error processing book ${asin}: ${error}`);
      this.reporter.bookDone?.(asin, false);
      return false;
    }
  }

  /** `asins`, when given, scopes the run to just those books (e.g. "convert
   * only what I selected") instead of everything ready for conversion. */
  async convertAll(asins?: Set<string>): Promise<void> {
    this.reporter.log(`Scanning for AAX files in: ${this.sourceDir}`);
    this.reporter.log(`Output directory: ${this.outputDir}`);

    const ignoredAsins = getIgnoredAsins();
    const bookFiles = this.findBookFiles().filter(
      (b) => !ignoredAsins.has(b.asin) && (!asins || asins.has(b.asin)),
    );

    if (bookFiles.length === 0) {
      this.reporter.log("No matching AAX and chapter files found");
      this.reporter.log(
        "Make sure you have both .aax files and corresponding _chapters.json files",
      );
      return;
    }

    this.reporter.log(`\nFound ${bookFiles.length} books to convert:`);
    bookFiles.forEach((book) => {
      const name = book.bookTitle || `Book ${book.asin}`;
      this.reporter.log(`  - ${name} (${book.asin})`);
    });

    let successCount = 0;
    for (let i = 0; i < bookFiles.length; i++) {
      const book = bookFiles[i];
      const name = book.bookTitle || `Book ${book.asin}`;
      this.reporter.log(`\n[${i + 1}/${bookFiles.length}] Converting: ${name} (${book.asin})`);
      const success = await this.convertBook(
        book.aaxFile,
        book.chapterFile,
        book.asin,
        book.bookTitle,
        book.bookCover,
        book.voucherFile,
      );
      if (success) {
        successCount++;
      }

      if (i < bookFiles.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.convertDelayMs),
        );
      }
    }

    this.reporter.log(
      `\nConversion complete! ${successCount}/${bookFiles.length} succeeded.`,
    );
  }

  listBooks(): void {
    const ignoredAsins = getIgnoredAsins();
    const bookFiles = this.findBookFiles().filter((b) => !ignoredAsins.has(b.asin));

    if (bookFiles.length === 0) {
      this.reporter.log("No matching AAX and chapter files found");
      return;
    }

    this.reporter.log(
      `Found ${bookFiles.length} books ready for conversion:\n`,
    );

    bookFiles.forEach((book, index) => {
      const name = book.bookTitle || `Book ${book.asin}`;
      this.reporter.log(`${(index + 1).toString().padStart(2, " ")}. ${name}`);
      this.reporter.log(`    ASIN: ${book.asin}`);
      this.reporter.log(`     AAX: ${path.basename(book.aaxFile)}`);
      this.reporter.log(`    JSON: ${path.basename(book.chapterFile)}`);
      this.reporter.log(`   COVER: ${path.basename(book.bookCover)}`);
      this.reporter.log("");
    });
  }
}
