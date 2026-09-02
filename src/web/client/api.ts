import type {
  Book,
  LibraryStatus,
  SessionState,
  SettingsState,
  OperationStatus,
  OperationStartResult,
  OutputFormat,
  AudioFormat,
  AudioQuality,
} from "./types.ts";

/** Thrown for any non-2xx response; carries the parsed { error } message
 * when the server sent JSON, or the raw status text otherwise. */
export class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A 401/403 from any /api/* call means the session is gone or (in desktop
 * mode) the per-launch token cookie hasn't been set yet — either way, a
 * full document reload re-runs the guard middleware and either lands on
 * /login or re-applies the ?token= the desktop shell opened with. */
function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (isAuthFailure(res.status)) {
    location.reload();
    // location.reload() doesn't stop execution synchronously in every
    // browser, so throw to unwind the caller rather than let it act on a
    // response that was never actually authorized.
    throw new ApiRequestError(res.status, "Unauthorized");
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    const message = typeof body === "object" && body?.error ? body.error : String(body || res.statusText);
    throw new ApiRequestError(res.status, message);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const api = {
  session: {
    get: () => request<SessionState>("/api/session"),
    login: (name: string, password?: string) =>
      request<SessionState>("/api/session", { method: "POST", ...json({ name, password }) }),
    logout: () => request<void>("/api/session", { method: "DELETE" }),
  },

  users: {
    add: (name: string, password?: string, activationBytes?: string) =>
      request<SessionState>("/api/users", { method: "POST", ...json({ name, password, activationBytes }) }),
  },

  books: {
    list: () => request<Book[]>("/api/books"),
    status: () => request<LibraryStatus>("/api/status"),
    ignore: (asin: string) => request<void>(`/api/ignore/${asin}`, { method: "POST" }),
    unignore: (asin: string) => request<void>(`/api/unignore/${asin}`, { method: "POST" }),
    delete: (asin: string) => request<void>(`/api/delete/${asin}`, { method: "POST" }),
  },

  operation: {
    status: () => request<OperationStatus>("/api/operation"),
    cancel: () => request<{ ok: true }>("/api/operation/cancel", { method: "POST" }),
    sync: () => request<OperationStartResult>("/api/sync", { method: "POST" }),
    download: (asins?: string[], force?: boolean) =>
      request<OperationStartResult>("/api/download", { method: "POST", ...json({ asins, force }) }),
    downloadAll: (asins?: string[]) =>
      request<OperationStartResult>("/api/download-all", { method: "POST", ...json({ asins }) }),
    convert: (asin: string, force?: boolean) =>
      request<OperationStartResult>(`/api/convert/${asin}`, { method: "POST", ...json({ force }) }),
    prepare: (asin: string) => request<OperationStartResult>(`/api/prepare/${asin}`, { method: "POST" }),
  },

  settings: {
    get: () => request<SettingsState>("/api/settings"),
    update: (patch: {
      activationBytes?: string;
      password?: string;
      removePassword?: boolean;
      audioFormat?: AudioFormat;
      audioQuality?: AudioQuality;
      audioArgs?: string;
      audioCustomEnabled?: boolean;
      outputFormat?: OutputFormat;
    }) => request<SettingsState>("/api/settings", { method: "PATCH", ...json(patch) }),
  },

  audible: {
    loginUrl: (marketplace: string) =>
      request<{ url: string; marketplace: string }>("/api/audible/login-url", {
        method: "POST",
        ...json({ marketplace }),
      }),
    loginComplete: (redirectUrl: string) =>
      request<{ ok: true }>("/api/audible/login-complete", { method: "POST", ...json({ redirectUrl }) }),
    cancelPending: () => request<void>("/api/audible/pending", { method: "DELETE" }),
  },

  library: {
    reset: () => request<void>("/api/library/reset", { method: "POST" }),
  },

  tableState: {
    get: () => request<Record<string, unknown>>("/api/table-state"),
    save: (state: Record<string, unknown>) =>
      request<void>("/api/table-state", { method: "POST", ...json(state) }),
  },

  openOutput: () => request<void>("/open-output", { method: "POST" }),
};
