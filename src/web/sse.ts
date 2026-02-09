import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventReporter } from "../progress.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
          data: `<div id="op-progress" hx-swap-oob="true"><div class="progress-bar progress-bar-lg"><div class="progress-bar-fill" style="width:${data.percent}%;animation:none"></div></div><small class="progress-label">${escapeHtml(data.label)}: ${data.percent}%</small></div>`,
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
          data: `<span id="status-${escapeHtml(data.asin)}" hx-swap-oob="true"><span class="badge badge-warn">Processing&hellip;</span><div class="progress-bar"><div class="progress-bar-fill"></div></div></span>`,
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
          data: `<span id="status-${escapeHtml(data.asin)}" hx-swap-oob="true"><span class="badge badge-warn">${data.percent}%</span><div class="progress-bar"><div class="progress-bar-fill" style="width:${data.percent}%;animation:none"></div></div></span>`,
          event: "log",
        });
      } catch {
        // client disconnected
      }
    };

    const onBookDone = async (data: { asin: string; success: boolean }) => {
      if (closed) return;
      try {
        const badge = data.success
          ? '<span class="badge badge-success">Done</span>'
          : '<span class="badge badge-danger">Failed</span>';
        await stream.writeSSE({
          data: `<span id="status-${escapeHtml(data.asin)}" hx-swap-oob="true">${badge}</span>`,
          event: "log",
        });
      } catch {
        // client disconnected
      }
    };

    const onDone = async (result: { success: boolean; summary?: string }) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          data: `<div id="op-progress" hx-swap-oob="true"></div>`,
          event: "log",
        });
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
