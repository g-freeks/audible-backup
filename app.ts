#!/usr/bin/env node

import { execSync } from "child_process";
import { config } from "./src/config.ts";
import { AudibleLibrary } from "./src/library.ts";
import { Converter } from "./src/converter.ts";
import {
  closeDb,
  resetDatabase,
  getAllAudiobooks,
  getDownloadedAsins,
  getConvertedAsins,
} from "./src/db.ts";

function requireAudibleCli(): void {
  try {
    execSync("audible --version", { stdio: "ignore" });
  } catch {
    console.error(
      "Error: 'audible' CLI not found on PATH.\n\n" +
        "Install audible-cli using one of:\n" +
        "  pipx install audible-cli\n" +
        "  pip install audible-cli\n\n" +
        "Then run 'audible quickstart' to configure your account.",
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
  sync                Download new audiobooks (default)
  convert [asin]      Convert AAX files to MP3 chapters (all or specific ASIN)
  sync-convert        Download new books and convert all AAX files
  status              Show library status without downloading
  list                List books ready for conversion
  db-status           Show database contents
  help                Show this help message

Options:
  --dir <path>        Target directory for downloads (default from .env)
  --output <path>     Output directory for converted files (default from .env)
  --activation-bytes  Audible activation bytes (default from .env)

Examples:
  app.ts sync
  app.ts sync --dir ~/Music/audible
  app.ts convert
  app.ts convert B0763YT294
  app.ts sync-convert
  app.ts status
  app.ts db-status
  app.ts list
        `);
    return;
  }

  const targetDir = getArg(args, "--dir") || config.targetDir;
  const outputDir = getArg(args, "--output") || config.outputDir;
  const activationBytes =
    getArg(args, "--activation-bytes") || config.activationBytes;

  try {
    switch (command) {
      case "sync": {
        requireAudibleCli();
        const library = new AudibleLibrary(targetDir);
        await library.sync();
        break;
      }
      case "status": {
        requireAudibleCli();
        const library = new AudibleLibrary(targetDir);
        await library.listStatus();
        break;
      }
      case "convert": {
        const converter = new Converter(targetDir, outputDir, activationBytes);
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
        await library.sync();
        const converter = new Converter(targetDir, outputDir, activationBytes);
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
        const converted = getConvertedAsins();
        const all = getAllAudiobooks();

        console.log(`\nDatabase Status (${config.dbPath}):`);
        console.log(`Total tracked: ${all.length}`);
        console.log(`Downloaded: ${downloaded.size}`);
        console.log(`Converted: ${converted.size}`);

        if (all.length > 0) {
          console.log(`\nAudiobooks:`);
          for (const book of all) {
            const status = book.converted_at ? "converted" : "downloaded";
            const title = book.title || book.asin;
            const author = book.author ? `${book.author}: ` : "";
            console.log(`  [${status}] ${author}${title} (${book.asin})`);
          }
        }
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
