import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventReporter } from "../progress.ts";

/**
 * Bridges an operation's EventReporter to the client as Server-Sent Events:
 * each reporter event becomes a named SSE event with a JSON payload, and the
 * five per-book listeners collapse into one "book" event so the client has
 * a single case to switch on.
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
