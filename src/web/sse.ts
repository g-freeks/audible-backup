import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventReporter } from "../progress.ts";
import { escapeHtml } from "./templates/html.ts";
import { badge, bookStatusSwap, progressBar } from "./templates/components.ts";

export function sseStream(c: Context, reporter: EventReporter): Response {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let streamDone: () => void;
    const streamPromise = new Promise<void>((resolve) => {
      streamDone = resolve;
    });

    const onMessage = async (data: { type: string; message: string }) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          data: `<div class="log-line ${data.type}">${escapeHtml(data.message)}</div>`,
          event: "log",
        });
      } catch {
        // client disconnected
      }
    };

    const onProgress = async (data: { percent: number; label: string }) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          data: `<div id="op-progress" hx-swap-oob="true"><div class="progress-bar progress-bar-lg" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${data.percent}"><div class="progress-bar-fill" style="width:${data.percent}%;animation:none"></div></div><small class="progress-label">${escapeHtml(data.label)}: ${data.percent}%</small></div>`,
          event: "log",
        });
      } catch {
        // client disconnected
      }
    };

    const onBookStart = async (data: { asin: string }) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          data: bookStatusSwap(data.asin, badge("warn", "Processing…") + progressBar()),
          event: "log",
        });
      } catch {
        // client disconnected
      }
    };

    const onBookProgress = async (data: { asin: string; percent: number }) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          data: bookStatusSwap(
            data.asin,
            badge("warn", `${data.percent}%`) + progressBar(data.percent),
          ),
          event: "log",
        });
      } catch {
        // client disconnected
      }
    };

    const onBookDone = async (data: { asin: string; success: boolean }) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          data: bookStatusSwap(
            data.asin,
            data.success ? badge("success", "Done") : badge("danger", "Failed"),
          ),
          event: "log",
        });
      } catch {
        // client disconnected
      }
    };

    const onDone = async (result: {
      success: boolean;
      summary?: string;
      downloadUrl?: string;
    }) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          data: `<div id="op-progress" hx-swap-oob="true"></div>`,
          event: "log",
        });
        if (result.success && result.downloadUrl) {
          // app.js picks this up when the stream closes and starts the download.
          await stream.writeSSE({
            data: `<div id="op-download" hx-swap-oob="true" data-download-url="${escapeHtml(result.downloadUrl)}"></div>`,
            event: "log",
          });
        }
        await stream.writeSSE({
          data: `<div class="log-done ${result.success ? "success" : "error"}">${escapeHtml(result.summary || "Done")}</div>`,
          event: "log",
        });
        await stream.writeSSE({
          data: "",
          event: "done",
        });
      } catch {
        // client disconnected
      } finally {
        cleanup();
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      reporter.removeListener("message", onMessage);
      reporter.removeListener("progress", onProgress);
      reporter.removeListener("book-start", onBookStart);
      reporter.removeListener("book-progress", onBookProgress);
      reporter.removeListener("book-done", onBookDone);
      reporter.removeListener("done", onDone);
      streamDone();
    };

    reporter.on("message", onMessage);
    reporter.on("progress", onProgress);
    reporter.on("book-start", onBookStart);
    reporter.on("book-progress", onBookProgress);
    reporter.on("book-done", onBookDone);
    reporter.on("done", onDone);

    // Replay any events that were emitted before the SSE stream connected
    reporter.replay();

    stream.onAbort(() => {
      cleanup();
    });

    // Keep the stream open until the operation completes or the client disconnects.
    // Without this, the async callback returns immediately and Hono closes the stream.
    await streamPromise;
  }) as unknown as Response;
}

/**
 * JSON-payload sibling of sseStream(), for the SPA: same events, same
 * replay-before-connect semantics, but each `data:` line is JSON rather than
 * an HTML fragment, and the five per-book listeners collapse into one named
 * "book" event so the client has a single case to switch on.
 */
export function sseJsonStream(c: Context, reporter: EventReporter): Response {
  return streamSSE(c, async (stream) => {
    let closed = false;
    let streamDone: () => void;
    const streamPromise = new Promise<void>((resolve) => {
      streamDone = resolve;
    });

    const write = async (event: string, data: unknown) => {
      if (closed) return;
      try {
        await stream.writeSSE({ data: JSON.stringify(data), event });
      } catch {
        // client disconnected
      }
    };

    const onMessage = (data: { type: string; message: string }) => write("log", data);
    const onProgress = (data: { percent: number; label: string }) => write("progress", data);
    const onBookStart = (data: { asin: string }) => write("book", { asin: data.asin, state: "processing" });
    const onBookProgress = (data: { asin: string; percent: number }) =>
      write("book", { asin: data.asin, state: "processing", percent: data.percent });
    const onBookDone = (data: { asin: string; success: boolean }) =>
      write("book", { asin: data.asin, state: data.success ? "done" : "failed" });

    const onDone = async (result: { success: boolean; summary?: string; downloadUrl?: string }) => {
      if (closed) return;
      try {
        await stream.writeSSE({ data: JSON.stringify(result), event: "done" });
      } catch {
        // client disconnected
      } finally {
        cleanup();
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      reporter.removeListener("message", onMessage);
      reporter.removeListener("progress", onProgress);
      reporter.removeListener("book-start", onBookStart);
      reporter.removeListener("book-progress", onBookProgress);
      reporter.removeListener("book-done", onBookDone);
      reporter.removeListener("done", onDone);
      streamDone();
    };

    reporter.on("message", onMessage);
    reporter.on("progress", onProgress);
    reporter.on("book-start", onBookStart);
    reporter.on("book-progress", onBookProgress);
    reporter.on("book-done", onBookDone);
    reporter.on("done", onDone);

    // Replay any events that were emitted before the SSE stream connected.
    reporter.replay();

    stream.onAbort(() => {
      cleanup();
    });

    // Keep the stream open until the operation completes or the client
    // disconnects — otherwise the async callback returns immediately and
    // Hono closes the stream.
    await streamPromise;
  }) as unknown as Response;
}
