import { Hono } from "hono";
import { config } from "../config.ts";

import * as fs from "fs";
import * as path from "path";
import { getAllAudiobooks, getDownloadedAsins, getConvertedAsins, getNotDownloadedBooks, getAudiobookByAsin, getIgnoredAsins, isConverted, ignoreBook, unignoreBook, deleteBook } from "../db.ts";
import { AudibleLibrary, type AudiobookEntry } from "../library.ts";
import { Converter } from "../converter.ts";
import {
  isOperationRunning,
  getActiveOperation,
  startOperation,
  clearOperation,
} from "../operations.ts";
import { sseStream } from "./sse.ts";
import { booksPage } from "./templates/books.ts";

export const routes = new Hono();

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

function isValidAsin(asin: string): boolean {
  return ASIN_PATTERN.test(asin);
}

// --- Pages ---

routes.get("/", (c) => {
  let convertibleAsins = new Set<string>();
  try {
    const converter = new Converter(
      config.targetDir,
      config.outputDir,
      config.activationBytes,
    );
    convertibleAsins = new Set(converter.findBookFiles().map((b) => b.asin));
  } catch {
    // activation bytes or target dir may not be configured
  }
  return c.html(booksPage(convertibleAsins));
});
routes.get("/library", (c) => c.redirect("/"));
routes.get("/convert", (c) => c.redirect("/"));

// --- JSON API ---

routes.get("/api/status", (c) => {
  const all = getAllAudiobooks();
  const downloaded = getDownloadedAsins();
  const converted = getConvertedAsins();
  return c.json({
    total: all.length,
    downloaded: downloaded.size,
    converted: converted.size,
    pending: downloaded.size - converted.size,
  });
});

routes.get("/api/books", (c) => {
  return c.json(getAllAudiobooks());
});

// --- Ignore / Unignore ---

routes.post("/api/ignore/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.text("Invalid ASIN", 400);
  ignoreBook(asin);
  return c.redirect("/");
});

routes.post("/api/unignore/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.text("Invalid ASIN", 400);
  unignoreBook(asin);
  return c.redirect("/");
});

routes.post("/api/delete/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.text("Invalid ASIN", 400);
  const book = getAudiobookByAsin(asin);

  if (book) {
    // Delete .aax file
    if (book.aax_path && fs.existsSync(book.aax_path)) {
      fs.unlinkSync(book.aax_path);
    }
    // Delete chapter .json and cover .jpg (same directory as .aax)
    if (book.aax_path) {
      const dir = path.dirname(book.aax_path);
      const chapterFile = path.join(dir, `${asin}-chapters.json`);
      const coverPattern = new RegExp(`${asin}.*\\.jpg$`);
      if (fs.existsSync(chapterFile)) fs.unlinkSync(chapterFile);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (coverPattern.test(f)) {
            fs.unlinkSync(path.join(dir, f));
          }
        }
      } catch {
        // dir may not exist
      }
    }
    // Delete output directory
    if (book.output_path && fs.existsSync(book.output_path)) {
      fs.rmSync(book.output_path, { recursive: true, force: true });
    }
    // Reset DB fields
    deleteBook(asin);
  }

  return c.redirect("/");
});

// --- Sync ---

routes.post("/library/sync", (c) => {
  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const reporter = startOperation("sync");

  const library = new AudibleLibrary(config.targetDir, reporter);
  library
    .sync()
    .then(() => reporter.done({ success: true, summary: "Sync complete" }))
    .catch((err: Error) =>
      reporter.done({ success: false, summary: err.message }),
    )
    .finally(() => clearOperation());

  return c.html(logPanel("/library/sync/stream", "Sync started..."));
});

routes.get("/library/sync/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "sync") {
    return c.text("No active sync operation", 404);
  }
  return sseStream(c, op.reporter);
});

// --- Download ---

routes.post("/library/download", async (c) => {
  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const body = await c.req.parseBody({ all: true });
  let asins: string[] = [];
  if (body.asin) {
    asins = Array.isArray(body.asin) ? body.asin as string[] : [body.asin as string];
    if (!asins.every(isValidAsin)) {
      return c.html(
        '<div class="log-panel"><div class="log-line error">Invalid ASIN</div></div>',
        400,
      );
    }
  }
  const force = body.force === "true";

  const reporter = startOperation("download");

  const library = new AudibleLibrary(config.targetDir, reporter);

  // Build the book list from ASINs or default to all not-downloaded
  let books: AudiobookEntry[];
  if (asins.length > 0) {
    books = asins.map((asin) => {
      const row = getAudiobookByAsin(asin);
      return {
        asin,
        author: row?.author || "",
        title: row?.title || asin,
        fullLine: "",
      };
    });
  } else {
    const notDownloaded = getNotDownloadedBooks();
    books = notDownloaded.map((row) => ({
      asin: row.asin,
      author: row.author || "",
      title: row.title || row.asin,
      fullLine: "",
    }));
  }

  library
    .downloadBooks(books, force)
    .then(() => reporter.done({ success: true, summary: "Download complete" }))
    .catch((err: Error) =>
      reporter.done({ success: false, summary: err.message }),
    )
    .finally(() => clearOperation());

  const oobSwaps = books.map((b) =>
    `<span id="status-${escapeHtml(b.asin)}" hx-swap-oob="true"><span class="badge badge-muted">Queued</span></span>`
  ).join("");

  return c.html(logPanel("/library/download/stream", "Download started...", oobSwaps));
});

routes.get("/library/download/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "download") {
    return c.text("No active download operation", 404);
  }
  return sseStream(c, op.reporter);
});

// --- Convert All ---

routes.post("/convert/all", async (c) => {
  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const body = await c.req.parseBody();
  const force = body.force === "true";

  const reporter = startOperation("convert");

  try {
    const converter = new Converter(
      config.targetDir,
      config.outputDir,
      config.activationBytes,
      reporter,
      force,
    );

    const ignoredAsins = getIgnoredAsins();
    const queuedBooks = converter.findBookFiles().filter((b) => !ignoredAsins.has(b.asin) && (force || !isConverted(b.asin)));
    const oobSwaps = queuedBooks.map((b) =>
      `<span id="status-${escapeHtml(b.asin)}" hx-swap-oob="true"><span class="badge badge-muted">Queued</span></span>`
    ).join("");

    converter
      .convertAll()
      .then(() =>
        reporter.done({ success: true, summary: "Conversion complete" }),
      )
      .catch((err: Error) =>
        reporter.done({ success: false, summary: err.message }),
      )
      .finally(() => clearOperation());

    return c.html(logPanel("/convert/stream", "Conversion started...", oobSwaps));
  } catch (err) {
    clearOperation();
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(
      `<div class="log-panel"><div class="log-line error">${escapeHtml(msg)}</div></div>`,
      400,
    );
  }
});

// --- Convert Single ---

routes.post("/convert/:asin", async (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) {
    return c.html(
      '<div class="log-panel"><div class="log-line error">Invalid ASIN</div></div>',
      400,
    );
  }

  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const body = await c.req.parseBody();
  const force = body.force === "true";

  const reporter = startOperation("convert");

  try {
    const converter = new Converter(
      config.targetDir,
      config.outputDir,
      config.activationBytes,
      reporter,
      force,
    );
    const books = converter.findBookFiles();
    const book = books.find((b) => b.asin === asin);

    if (!book) {
      clearOperation();
      return c.html(
        `<div class="log-panel"><div class="log-line error">Book with ASIN ${escapeHtml(asin)} not found</div></div>`,
        404,
      );
    }

    converter
      .convertBook(
        book.aaxFile,
        book.chapterFile,
        book.asin,
        book.bookTitle,
        book.bookCover,
      )
      .then((success) =>
        reporter.done({
          success,
          summary: success
            ? `Successfully converted ${book.bookTitle || asin}`
            : `Failed to convert ${book.bookTitle || asin}`,
        }),
      )
      .catch((err: Error) =>
        reporter.done({ success: false, summary: err.message }),
      )
      .finally(() => clearOperation());

    const oobSwap = `<span id="status-${escapeHtml(asin)}" hx-swap-oob="true"><span class="badge badge-warn">Converting&hellip;</span><div class="progress-bar"><div class="progress-bar-fill"></div></div></span>`;

    return c.html(logPanel("/convert/stream", `Converting ${escapeHtml(asin)}...`, oobSwap));
  } catch (err) {
    clearOperation();
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(
      `<div class="log-panel"><div class="log-line error">${escapeHtml(msg)}</div></div>`,
      400,
    );
  }
});

routes.get("/convert/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "convert") {
    return c.text("No active convert operation", 404);
  }
  return sseStream(c, op.reporter);
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function logPanel(streamUrl: string, label: string, extra: string = ""): string {
  return `
    <div id="op-progress"></div>
    <div class="log-panel"
      hx-ext="sse"
      sse-connect="${streamUrl}"
      sse-swap="log"
      sse-close="done"
      hx-swap="beforeend">
      <div class="log-line">${escapeHtml(label)}</div>
    </div>
    ${extra}
  `;
}
