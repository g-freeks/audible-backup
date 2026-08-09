import { execSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.ts";
import {
  getDownloadedAsins,
  getIgnoredAsins,
  markDownloaded,
  markNotDownloadable,
  importExistingDownloads,
  upsertBook,
} from "./db.ts";
import { type ProgressReporter, consoleReporter } from "./progress.ts";
import { currentUserName, userDirs } from "./users.ts";
import {
  runHelper,
  HelperUnavailableError,
  type HelperLibraryItem,
} from "./pyhelper.ts";

/**
 * Turn an audible-cli failure into something actionable. Signing in is a
 * one-time command-line step (there is no web flow for it), so say so.
 */
export function describeAudibleCliError(error: unknown): string {
  const text = String(error);
  const user = currentUserName();
  const configHint = user
    ? `docker compose exec -e AUDIBLE_CONFIG_DIR=/data/users/${user}/audible audible-backup audible quickstart`
    : "docker compose exec audible-backup audible quickstart";

  if (/not found|ENOENT/i.test(text)) {
    return (
      "audible-cli is not installed or not on PATH. It ships with the Docker " +
      "image; if you are running outside Docker, install it with " +
      "'pipx install audible-cli'."
    );
  }
  if (/auth|login|profile|config|credential|unauthorized|401/i.test(text)) {
    return (
      `Audible sign-in required${user ? ` for user '${user}'` : ""}. ` +
      `Signing in is a one-time command-line step:\n  ${configHint}`
    );
  }
  return `Failed to get library list: ${text}`;
}

/** Env for audible-cli invocations: per-user config dir in multi-tenant mode. */
function audibleEnv(): NodeJS.ProcessEnv {
  const userName = currentUserName();
  if (userName) {
    return { ...process.env, AUDIBLE_CONFIG_DIR: userDirs(userName).authDir };
  }
  return process.env;
}

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
        if (
          file.isFile() &&
          (file.name.endsWith(".aax") || file.name.endsWith(".aaxc"))
        ) {
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

  async getLibraryList(): Promise<AudiobookEntry[]> {
    const viaHelper = await this.libraryViaHelper();
    if (viaHelper !== null) return viaHelper;
    return this.libraryViaCli();
  }

  /** Structured listing via the Python helper; null if the helper is unavailable. */
  private async libraryViaHelper(): Promise<AudiobookEntry[] | null> {
    try {
      this.reporter.log("Fetching library list from Audible...");
      const done = await runHelper(["library"], (ev) => {
        if (ev.type === "error") this.reporter.error(String(ev.message));
      });
      if (!done.ok) {
        throw new Error(done.message || `Helper failed: ${done.reason}`);
      }
      const items = (done.items as HelperLibraryItem[]) || [];
      return items
        .filter((item) => item.asin && item.downloadable !== false)
        .map((item) => ({
          asin: item.asin,
          author: item.authors || "",
          title: item.title || item.asin,
          fullLine: "",
        }));
    } catch (error) {
      if (error instanceof HelperUnavailableError) {
        this.reporter.log("Python helper unavailable, falling back to audible-cli");
        return null;
      }
      throw new Error(`Failed to get library list: ${error}`);
    }
  }

  private libraryViaCli(): AudiobookEntry[] {
    try {
      const output = execSync("audible library list", {
        encoding: "utf8",
        maxBuffer: config.libraryMaxBuffer,
        env: audibleEnv(),
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
      throw new Error(describeAudibleCliError(error));
    }
  }

  /** Find the actual .aax/.aaxc file for an ASIN — filenames include more than the bare ASIN. */
  private findAaxFile(asin: string): string | undefined {
    try {
      const files = fs.readdirSync(this.targetDir, {
        recursive: true,
        withFileTypes: true,
      });
      for (const file of files) {
        if (
          file.isFile() &&
          (file.name.endsWith(".aax") || file.name.endsWith(".aaxc")) &&
          file.name.includes(asin)
        ) {
          return path.join(file.parentPath, file.name);
        }
      }
    } catch {
      // target dir may not be readable
    }
    return undefined;
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
    this.reporter.log(`Downloading: ${author}: ${title} (${asin})`);
    const viaHelper = await this.downloadViaHelper(asin, author, title);
    if (viaHelper !== null) return viaHelper;
    return this.downloadViaCli(asin, author, title, force);
  }

  /**
   * AAXC download via the Python helper (license request + voucher + chapters
   * + cover). Returns null if the helper is unavailable so the audible-cli
   * AAX path can take over.
   */
  private async downloadViaHelper(
    asin: string,
    author: string,
    title: string,
  ): Promise<boolean | null> {
    try {
      const done = await runHelper(["download", asin, this.targetDir, title], (ev) => {
        if (ev.type === "progress") {
          this.reporter.bookProgress?.(asin, Number(ev.pct));
        } else if (ev.type === "log") {
          this.reporter.log(String(ev.message));
        } else if (ev.type === "error") {
          this.reporter.error(String(ev.message));
        }
      });
      if (!done.ok) {
        if (done.reason === "not_downloadable") {
          this.reporter.warn(`Marked as not downloadable: ${title}`);
          markNotDownloadable(asin);
        } else {
          this.reporter.error(
            `Failed to download ${title}: ${done.message || done.reason}`,
          );
        }
        return false;
      }
      const files = (done.files || {}) as { aaxc?: string };
      const aaxPath =
        files.aaxc || this.findAaxFile(asin) || path.join(this.targetDir, `${asin}.aaxc`);
      markDownloaded(asin, author, title, aaxPath);
      this.reporter.log(`Successfully downloaded: ${title}`);
      return true;
    } catch (error) {
      if (error instanceof HelperUnavailableError) {
        this.reporter.log("Python helper unavailable, falling back to audible-cli");
        return null;
      }
      this.reporter.error(`Error downloading ${title}: ${error}`);
      return false;
    }
  }

  private async downloadViaCli(
    asin: string,
    author: string,
    title: string,
    force: boolean = false,
  ): Promise<boolean> {
    const result = await new Promise((resolve) => {

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
          env: audibleEnv(),
        },
      );

      let outputText = "";
      downloadProcess.stdout?.on("data", (data: Buffer) => {
        outputText += data.toString();
      });
      downloadProcess.stderr?.on("data", (data: Buffer) => {
        outputText += data.toString();
      });

      this.pipeProcessOutput(downloadProcess, asin);

      downloadProcess.on("close", (code) => {
        if (outputText.includes("is not downloadable")) {
          this.reporter.warn(`Marked as not downloadable: ${title}`);
          markNotDownloadable(asin);
          resolve(false);
        } else if (code === 0) {
          this.reporter.log(`Successfully downloaded: ${title}`);
          const aaxPath =
            this.findAaxFile(asin) || path.join(this.targetDir, `${asin}.aax`);
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
          env: audibleEnv(),
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
    const libraryEntries = await this.getLibraryList();
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
    const libraryEntries = await this.getLibraryList();
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
