import { execSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.ts";
import {
  getDownloadedAsins,
  getIgnoredAsins,
  markDownloaded,
  importExistingDownloads,
  upsertBook,
} from "./db.ts";
import { type ProgressReporter, consoleReporter } from "./progress.ts";

export interface AudiobookEntry {
  asin: string;
  author: string;
  title: string;
  fullLine: string;
}

export class AudibleLibrary {
  readonly targetDir: string;
  private reporter: ProgressReporter;

  constructor(
    targetDir: string = config.targetDir,
    reporter: ProgressReporter = consoleReporter,
  ) {
    this.reporter = reporter;
    this.targetDir = path.resolve(
      targetDir.replace("~", process.env.HOME || ""),
    );
    this.ensureTargetDirectory();
    this.importExistingFiles();
  }

  ensureTargetDirectory(): void {
    if (!fs.existsSync(this.targetDir)) {
      fs.mkdirSync(this.targetDir, { recursive: true });
      this.reporter.log(`Created target directory: ${this.targetDir}`);
    }
  }

  importExistingFiles(): void {
    try {
      const files = fs.readdirSync(this.targetDir, {
        recursive: true,
        withFileTypes: true,
      });
      const found = new Map<string, string>();
      files.forEach((file) => {
        if (file.isFile() && file.name.endsWith(".aax")) {
          const asinMatch = file.name.match(/([A-Z0-9]{10})/);
          if (asinMatch) {
            found.set(asinMatch[1], path.join(file.parentPath, file.name));
          }
        }
      });
      if (found.size > 0) {
        const imported = importExistingDownloads(found);
        if (imported > 0) {
          this.reporter.log(
            `Imported ${imported} existing downloads into database`,
          );
        }
      }
    } catch (error) {
      this.reporter.warn(
        `Warning: Could not scan existing downloads: ${error}`,
      );
    }
  }

  getLibraryList(): AudiobookEntry[] {
    try {
      this.reporter.log("Fetching library list from Audible...");
      const output = execSync("audible library list", {
        encoding: "utf8",
        maxBuffer: config.libraryMaxBuffer,
      });

      const entries: AudiobookEntry[] = [];
      const lines = output.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        const match = line.match(/^([A-Z0-9]{10}):\s*(.+?):\s*(.+)$/);
        if (match) {
          const [, asin, author, title] = match;
          entries.push({
            asin,
            author: author.trim(),
            title: title.trim(),
            fullLine: line,
          });
        }
      }

      return entries;
    } catch (error) {
      throw new Error(`Failed to get library list: ${error}`);
    }
  }

  private pipeProcessOutput(proc: ChildProcess, asin?: string): void {
    let lastPct = -1;
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split(/[\r\n]+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const pctMatch = trimmed.match(/(\d+)%/);
        if (pctMatch) {
          const pct = parseInt(pctMatch[1]);
          if (pct !== lastPct) {
            lastPct = pct;
            if (asin) {
              this.reporter.bookProgress?.(asin, pct);
            } else {
              this.reporter.progress?.(pct, "Downloading");
            }
          }
        } else {
          this.reporter.log(trimmed);
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.reporter.error(text);
    });
  }

  async downloadBook(
    asin: string,
    author: string,
    title: string,
    force: boolean = false,
  ): Promise<boolean> {
    const result = await new Promise((resolve) => {
      this.reporter.log(`Downloading: ${author}: ${title} (${asin})`);

      const downloadArgs = [
        "download",
        "--asin",
        asin,
        "-o",
        this.targetDir,
        "--aax",
        "--cover",
        "--chapter",
        "--annotation",
        "-f",
        "asin_ascii",
        "--ignore-podcasts",
      ];
      if (force) downloadArgs.push("--overwrite");

      const downloadProcess = spawn(
        "audible",
        downloadArgs,
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      this.pipeProcessOutput(downloadProcess, asin);

      downloadProcess.on("close", (code) => {
        if (code === 0) {
          this.reporter.log(`Successfully downloaded: ${title}`);
          const aaxPath = path.join(this.targetDir, `${asin}.aax`);
          markDownloaded(asin, author, title, aaxPath);
          resolve(true);
        } else {
          this.reporter.error(
            `Failed to download: ${title} (exit code: ${code})`,
          );
          resolve(false);
        }
      });

      downloadProcess.on("error", (error) => {
        this.reporter.error(`Error downloading ${title}: ${error}`);
        resolve(false);
      });
    });

    return !!result;
  }

  async downloadAll(): Promise<void> {
    this.reporter.log("Downloading entire library...");

    return new Promise((resolve, reject) => {
      const downloadProcess = spawn(
        "audible",
        [
          "download",
          "--all",
          "-o",
          this.targetDir,
          "--aax",
          "--cover",
          "--chapter",
          "--annotation",
          "-f",
          "asin_ascii",
          "--ignore-podcasts",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      this.pipeProcessOutput(downloadProcess);

      downloadProcess.on("close", (code) => {
        if (code === 0) {
          this.reporter.log("Successfully downloaded entire library");
          this.importExistingFiles();
          resolve();
        } else {
          reject(new Error(`Download failed with exit code: ${code}`));
        }
      });

      downloadProcess.on("error", (error) => {
        reject(new Error(`Download process error: ${error}`));
      });
    });
  }

  async sync(force: boolean = false): Promise<AudiobookEntry[]> {
    const libraryEntries = this.getLibraryList();
    this.reporter.log(`Found ${libraryEntries.length} books in library`);

    const ignoredAsins = getIgnoredAsins();
    let books: AudiobookEntry[];

    if (force) {
      books = libraryEntries.filter(
        (entry) => !ignoredAsins.has(entry.asin),
      );
    } else {
      const downloadedAsins = getDownloadedAsins();
      books = libraryEntries.filter(
        (entry) => !downloadedAsins.has(entry.asin) && !ignoredAsins.has(entry.asin),
      );
    }

    // Upsert all books into the DB so the web UI can display them
    for (const book of books) {
      upsertBook(book.asin, book.author, book.title);
    }

    if (books.length === 0) {
      this.reporter.log("All books are already downloaded (or ignored). Nothing new.");
    } else {
      this.reporter.log(`Found ${books.length} ${force ? "" : "new "}books:`);
      books.forEach((book) => {
        this.reporter.log(`  - ${book.author}: ${book.title} (${book.asin})`);
      });
    }

    return books;
  }

  async downloadBooks(books: AudiobookEntry[], force: boolean = false): Promise<void> {
    if (books.length === 0) {
      this.reporter.log("No books to download.");
      return;
    }

    this.reporter.log(`Downloading ${books.length} book${books.length === 1 ? "" : "s"}...`);

    let successCount = 0;
    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      this.reporter.log(`\n[${i + 1}/${books.length}] ${book.author}: ${book.title} (${book.asin})`);
      this.reporter.bookStart?.(book.asin);
      const success = await this.downloadBook(
        book.asin,
        book.author,
        book.title,
        force,
      );
      this.reporter.bookDone?.(book.asin, success);
      if (success) {
        successCount++;
      }

      if (i < books.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.downloadDelayMs),
        );
      }
    }

    this.reporter.log(
      `\nDownload complete! ${successCount}/${books.length} succeeded.`,
    );
  }

  async listStatus(): Promise<void> {
    const libraryEntries = this.getLibraryList();
    const downloadedAsins = getDownloadedAsins();
    const ignoredAsins = getIgnoredAsins();
    const newBooks = libraryEntries.filter(
      (entry) => !downloadedAsins.has(entry.asin) && !ignoredAsins.has(entry.asin),
    );

    this.reporter.log(`\nLibrary Status:`);
    this.reporter.log(`Total books in library: ${libraryEntries.length}`);
    this.reporter.log(`Already downloaded: ${downloadedAsins.size}`);
    this.reporter.log(`Ignored: ${ignoredAsins.size}`);
    this.reporter.log(`New books available: ${newBooks.length}`);

    if (newBooks.length > 0) {
      this.reporter.log(`\nNew books:`);
      newBooks.forEach((book) => {
        this.reporter.log(`  - ${book.author}: ${book.title} (${book.asin})`);
      });
    }
  }
}
