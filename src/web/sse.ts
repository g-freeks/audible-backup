import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventReporter } from "../progress.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function sseStream(c: Context, reporter: EventReporter): Response {
  return streamSSE(c, async (stream) => {
    let closed = false;

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

    const onDone = async (result: { success: boolean; summary?: string }) => {
      if (closed) return;
      try {
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
      closed = true;
      reporter.removeListener("message", onMessage);
      reporter.removeListener("done", onDone);
    };

    reporter.on("message", onMessage);
    reporter.on("done", onDone);

    stream.onAbort(() => {
      cleanup();
    });
  }) as unknown as Response;
}
