import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.ts";
import {
  getDownloadedAsins,
  getIgnoredAsins,
  markDownloaded,
  importExistingDownloads,
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
      this.reporter.log("Fetching library list...");
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

  async downloadBook(
    asin: string,
    author: string,
    title: string,
  ): Promise<boolean> {
    const result = await new Promise((resolve) => {
      this.reporter.log(`Downloading: ${author}: ${title} (${asin})`);

      const downloadProcess = spawn(
        "audible",
        [
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
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      downloadProcess.stdout?.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) this.reporter.log(text);
      });

      downloadProcess.stderr?.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) this.reporter.error(text);
      });

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

      downloadProcess.stdout?.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) this.reporter.log(text);
      });

      downloadProcess.stderr?.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) this.reporter.error(text);
      });

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

  async sync(): Promise<void> {
    const libraryEntries = this.getLibraryList();
    this.reporter.log(`Found ${libraryEntries.length} books in library`);

    const downloadedAsins = getDownloadedAsins();

    if (downloadedAsins.size === 0) {
      this.reporter.log("No downloads recorded. Downloading entire library...");
      await this.downloadAll();
      return;
    }

    const ignoredAsins = getIgnoredAsins();
    const newBooks = libraryEntries.filter(
      (entry) => !downloadedAsins.has(entry.asin) && !ignoredAsins.has(entry.asin),
    );

    if (newBooks.length === 0) {
      this.reporter.log("All books are already downloaded (or ignored). Nothing to sync.");
      return;
    }

    this.reporter.log(`Found ${newBooks.length} new books to download:`);
    newBooks.forEach((book) => {
      this.reporter.log(`  - ${book.author}: ${book.title} (${book.asin})`);
    });

    let successCount = 0;
    for (const book of newBooks) {
      const success = await this.downloadBook(
        book.asin,
        book.author,
        book.title,
      );
      if (success) {
        successCount++;
      }

      if (book !== newBooks[newBooks.length - 1]) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.downloadDelayMs),
        );
      }
    }

    this.reporter.log(
      `\nSync complete! Downloaded ${successCount}/${newBooks.length} new books.`,
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
