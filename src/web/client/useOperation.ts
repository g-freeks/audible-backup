import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "./api.ts";
import type { OperationStartResult } from "./types.ts";

export interface LogLine {
  type: "log" | "error" | "warn";
  message: string;
}

export interface OperationProgress {
  percent: number;
  label: string;
}

export type BookOpState = "queued" | "processing" | "done" | "failed";

export interface BookOpStatus {
  state: BookOpState;
  percent?: number;
}

export interface OperationResult {
  success: boolean;
  summary?: string;
  downloadUrl?: string;
}

export interface OperationState {
  running: boolean;
  type: string | null;
  logs: LogLine[];
  progress: OperationProgress | null;
  books: Record<string, BookOpStatus>;
  result: OperationResult | null;
}

const EMPTY_STATE: OperationState = {
  running: false,
  type: null,
  logs: [],
  progress: null,
  books: {},
  result: null,
};

/**
 * Owns the single global operation's live state (there is only ever one, per
 * operations.ts) — connects to GET /api/operation/stream, reconnects on
 * mount if one is already running (e.g. after a reload, or an auto-sync
 * kicked off right after connecting an Audible account), and exposes a
 * start() that fires a POST and immediately marks the returned ASINs
 * "queued" so row badges update before the first SSE event arrives.
 */
export function useOperation() {
  const [state, setState] = useState<OperationState>(EMPTY_STATE);
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback((type: string | null) => {
    sourceRef.current?.close();
    const source = new EventSource("/api/operation/stream");
    sourceRef.current = source;

    setState((prev) => ({ ...prev, running: true, type, result: null }));

    source.addEventListener("log", (e) => {
      const data: LogLine = JSON.parse((e as MessageEvent).data);
      setState((prev) => ({ ...prev, logs: [...prev.logs, data] }));
    });

    source.addEventListener("progress", (e) => {
      const data: OperationProgress = JSON.parse((e as MessageEvent).data);
      setState((prev) => ({ ...prev, progress: data }));
    });

    source.addEventListener("book", (e) => {
      const data: { asin: string; state: BookOpState; percent?: number } = JSON.parse(
        (e as MessageEvent).data,
      );
      setState((prev) => ({
        ...prev,
        books: { ...prev.books, [data.asin]: { state: data.state, percent: data.percent } },
      }));
    });

    source.addEventListener("done", (e) => {
      const data: OperationResult = JSON.parse((e as MessageEvent).data);
      setState((prev) => ({ ...prev, running: false, progress: null, result: data }));
      source.close();
      sourceRef.current = null;
      if (data.success && data.downloadUrl) {
        const a = document.createElement("a");
        a.href = data.downloadUrl;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });

    source.onerror = () => {
      // The server only ever closes the stream itself via the "done" event
      // (or the operation simply wasn't there — see the mount-time check
      // below); any other close is a dropped connection, not completion.
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.operation
      .status()
      .then((status) => {
        if (!cancelled && status.running) connect(status.type ?? null);
      })
      .catch(() => {
        // Not signed in yet, or desktop token not set — nothing to attach to.
      });
    return () => {
      cancelled = true;
      sourceRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connect is stable (empty deps)
  }, []);

  const reset = useCallback(() => setState(EMPTY_STATE), []);

  /** Starts an operation via `starter`, marks its queued ASINs immediately,
   * and connects to the stream. Throws ApiRequestError (e.g. 409) without
   * mutating state, so callers can show it as a toast. */
  const start = useCallback(
    async (starter: () => Promise<OperationStartResult>) => {
      const result = await starter();
      setState((prev) => ({
        ...prev,
        logs: [],
        result: null,
        books: {
          ...prev.books,
          ...Object.fromEntries(result.queued.map((asin) => [asin, { state: "queued" as const }])),
        },
      }));
      connect(result.type);
      return result;
    },
    [connect],
  );

  const cancel = useCallback(async () => {
    try {
      await api.operation.cancel();
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.status === 404)) throw err;
    }
  }, []);

  return { ...state, start, cancel, reset };
}
