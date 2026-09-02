#!/usr/bin/env node

import { execSync } from "child_process";
import { config } from "./src/config.ts";
import { AudibleLibrary } from "./src/library.ts";
import { Converter, findConvertedChapters, DEFAULT_AUDIO_SETTINGS, DEFAULT_OUTPUT_FORMAT } from "./src/converter.ts";
import { consoleReporter } from "./src/progress.ts";
import {
  closeDb,
  resetDatabase,
  getAllAudiobooks,
  getDownloadedAsins,
  getAllIgnoredBooks,
  getAudiobookByAsin,
  ignoreBook,
  unignoreBook,
} from "./src/db.ts";
import { getUser, listUsers, runWithUser, userDirs } from "./src/users.ts";

function requireAudibleCli(): void {
  try {
    execSync("audible --version", { stdio: "ignore" });
  } catch {
    console.error(
      "Error: 'audible' CLI not found on PATH.\n\n" +
        "It is only needed for the legacy audible-cli path; the built-in " +
        "client is used by default. Sign in from the web UI under " +
        "Settings \u2192 Connect Audible, or install audible-cli with " +
        "'pipx install audible-cli' if you specifically want that path.",
    );
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "sync";

  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`
Audible Backup Tool

Usage:
  app.ts [command] [options]

Commands:
  sync                Sync library metadata and download new audiobooks (default)
  download <asin>     Download a single book by ASIN
  convert [asin]      Convert AAX files to MP3 chapters (all or specific ASIN)
  sync-convert        Sync, download new books, and convert all AAX files
  status              Show library status without downloading
  list                List books ready for conversion
  db-status           Show database contents
  ignore <asin>       Ignore a book (skip sync, convert, status)
  unignore <asin>     Unignore a previously ignored book
  help                Show this help message

Options:
  --user <name>       Run as a registered user (their directories, database,
                      Audible auth, and activation bytes)
  --dir <path>        Target directory for downloads (default from .env)
  --output <path>     Output directory for converted files (default from .env)
  --activation-bytes  Audible activation bytes (default from .env)
  --force             Re-download or re-convert even if already done

Examples:
  app.ts sync
  app.ts sync --dir ~/Music/audible
  app.ts download B0763YT294
  app.ts convert
  app.ts convert B0763YT294
  app.ts sync-convert
  app.ts status
  app.ts db-status
  app.ts list
  app.ts ignore B0763YT294
  app.ts unignore B0763YT294
        `);
    return;
  }

  const userArg = getArg(args, "--user");
  let user;
  if (userArg) {
    user = getUser(userArg);
    if (!user) {
      const names = listUsers().map((u) => u.name).join(", ") || "(none)";
      console.error(`Unknown user: ${userArg}. Registered users: ${names}`);
      process.exit(1);
    }
  }
  const dirs = user ? userDirs(user.name) : undefined;

  const targetDir = getArg(args, "--dir") || dirs?.targetDir || config.targetDir;
  const outputDir = getArg(args, "--output") || dirs?.outputDir || config.outputDir;
  const activationBytes =
    getArg(args, "--activation-bytes") ||
    user?.activationBytes ||
    config.activationBytes;
  const audioSettings = user?.audioSettings || DEFAULT_AUDIO_SETTINGS;
  const outputFormat = user?.outputFormat || DEFAULT_OUTPUT_FORMAT;
  const force = args.includes("--force");

  const run = user
    ? <T>(fn: () => Promise<T> | T) => runWithUser(user.name, fn)
    : <T>(fn: () => Promise<T> | T) => fn();

  try {
    await run(async () => {
    switch (command) {
      case "sync": {
        requireAudibleCli();
        const library = new AudibleLibrary(targetDir);
        const newBooks = await library.sync(force);
        await library.downloadBooks(newBooks, force);
        break;
      }
      case "download": {
        requireAudibleCli();
        const asin = args[1];
        if (!asin) {
          console.error("Usage: app.ts download <asin>");
          process.exit(1);
        }
        const library = new AudibleLibrary(targetDir);
        const book = getAudiobookByAsin(asin);
        await library.downloadBook(asin, book?.author || "", book?.title || asin, force);
        break;
      }
      case "status": {
        requireAudibleCli();
        const library = new AudibleLibrary(targetDir);
        await library.listStatus();
        break;
      }
      case "convert": {
        const converter = new Converter(targetDir, outputDir, activationBytes, consoleReporter, force, audioSettings, outputFormat);
        const asinArg = args.find((a) => a.match(/^[A-Z0-9]{10}$/));
        if (asinArg) {
          const books = converter.findBookFiles();
          const book = books.find((b) => b.asin === asinArg);
          if (book) {
            await converter.convertBook(
              book.aaxFile,
              book.chapterFile,
              book.asin,
              book.bookTitle,
              book.bookCover,
              book.voucherFile,
            );
          } else {
            console.error(
              `Book with ASIN ${asinArg} not found in ${targetDir}`,
            );
            process.exit(1);
          }
        } else {
          await converter.convertAll();
        }
        break;
      }
      case "sync-convert": {
        requireAudibleCli();
        const library = new AudibleLibrary(targetDir);
        const newBooks = await library.sync(force);
        await library.downloadBooks(newBooks, force);
        const converter = new Converter(targetDir, outputDir, activationBytes, consoleReporter, force, audioSettings, outputFormat);
        await converter.convertAll();
        break;
      }
      case "list": {
        const converter = new Converter(targetDir, outputDir, activationBytes);
        converter.listBooks();
        break;
      }
      case "db-status": {
        const downloaded = getDownloadedAsins();
        const all = getAllAudiobooks();
        const ignored = getAllIgnoredBooks();
        let convertedCount = 0;

        console.log(`\nDatabase Status (${config.dbPath}):`);
        console.log(`Total tracked: ${all.length}`);
        console.log(`Downloaded: ${downloaded.size}`);

        if (all.length > 0) {
          console.log(`\nAudiobooks:`);
          for (const book of all) {
            let status = "not-downloaded";
            if (book.downloaded_at) {
              const converted = findConvertedChapters(outputDir, book.asin, book.title || "", outputFormat).length > 0;
              if (converted) convertedCount++;
              status = converted ? "converted" : "downloaded";
            }
            const title = book.title || book.asin;
            const author = book.author ? `${book.author}: ` : "";
            console.log(`  [${status}] ${author}${title} (${book.asin})`);
          }
        }
        console.log(`Converted: ${convertedCount}`);
        console.log(`Ignored: ${ignored.length}`);

        if (ignored.length > 0) {
          console.log(`\nIgnored:`);
          for (const book of ignored) {
            const title = book.title || book.asin;
            const author = book.author ? `${book.author}: ` : "";
            console.log(`  [ignored] ${author}${title} (${book.asin})`);
          }
        }
        break;
      }
      case "ignore": {
        const asin = args[1];
        if (!asin) {
          console.error("Usage: app.ts ignore <asin>");
          process.exit(1);
        }
        ignoreBook(asin);
        console.log(`Ignored book: ${asin}`);
        break;
      }
      case "unignore": {
        const asin = args[1];
        if (!asin) {
          console.error("Usage: app.ts unignore <asin>");
          process.exit(1);
        }
        unignoreBook(asin);
        console.log(`Unignored book: ${asin}`);
        break;
      }
      case "db-reset": {
        console.log(`\nResetting Database`);
        resetDatabase();
        console.log(`Done`);
        break;
      }
      default:
        console.error(
          `Unknown command: ${command}. Use 'help' for usage info.`,
        );
        process.exit(1);
    }
    });
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    closeDb();
  }
}

export function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
}

const isMain =
  process.argv[1] &&
  import.meta.filename?.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  main().catch(console.error);
}
