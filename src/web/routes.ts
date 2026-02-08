import { Hono } from "hono";
import { config } from "../config.ts";
import { getAllAudiobooks, getDownloadedAsins, getConvertedAsins } from "../db.ts";
import { AudibleLibrary } from "../library.ts";
import { Converter } from "../converter.ts";
import {
  isOperationRunning,
  getActiveOperation,
  startOperation,
  clearOperation,
} from "../operations.ts";
import { sseStream } from "./sse.ts";
import { dashboardPage } from "./templates/dashboard.ts";
import { libraryPage } from "./templates/library.ts";
import { convertPage } from "./templates/convert.ts";

export const routes = new Hono();

// --- Pages ---

routes.get("/", (c) => c.html(dashboardPage()));
routes.get("/library", (c) => c.html(libraryPage()));
routes.get("/convert", (c) => c.html(convertPage()));

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

  return c.html(`
    <div class="log-panel"
      hx-ext="sse"
      sse-connect="/library/sync/stream"
      sse-swap="log"
      hx-swap="beforeend">
      <div class="log-line">Sync started...</div>
    </div>
  `);
});

routes.get("/library/sync/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "sync") {
    return c.text("No active sync operation", 404);
  }
  return sseStream(c, op.reporter);
});

// --- Convert All ---

routes.post("/convert/all", (c) => {
  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const reporter = startOperation("convert");

  try {
    const converter = new Converter(
      config.targetDir,
      config.outputDir,
      config.activationBytes,
      reporter,
    );
    converter
      .convertAll()
      .then(() =>
        reporter.done({ success: true, summary: "Conversion complete" }),
      )
      .catch((err: Error) =>
        reporter.done({ success: false, summary: err.message }),
      )
      .finally(() => clearOperation());
  } catch (err) {
    clearOperation();
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(
      `<div class="log-panel"><div class="log-line error">${escapeHtml(msg)}</div></div>`,
      400,
    );
  }

  return c.html(`
    <div class="log-panel"
      hx-ext="sse"
      sse-connect="/convert/stream"
      sse-swap="log"
      hx-swap="beforeend">
      <div class="log-line">Conversion started...</div>
    </div>
  `);
});

// --- Convert Single ---

routes.post("/convert/:asin", (c) => {
  const asin = c.req.param("asin");

  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const reporter = startOperation("convert");

  try {
    const converter = new Converter(
      config.targetDir,
      config.outputDir,
      config.activationBytes,
      reporter,
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
  } catch (err) {
    clearOperation();
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(
      `<div class="log-panel"><div class="log-line error">${escapeHtml(msg)}</div></div>`,
      400,
    );
  }

  return c.html(`
    <div class="log-panel"
      hx-ext="sse"
      sse-connect="/convert/stream"
      sse-swap="log"
      hx-swap="beforeend">
      <div class="log-line">Converting ${escapeHtml(asin)}...</div>
    </div>
  `);
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
