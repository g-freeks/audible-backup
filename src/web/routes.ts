import { Hono } from "hono";
import { config } from "../config.ts";

import * as fs from "fs";
import * as path from "path";
import { getAllAudiobooks, getDownloadedAsins, getNotDownloadedBooks, getAudiobookByAsin, getIgnoredAsins, ignoreBook, unignoreBook, deleteBook, resetDatabase, getAllBooks } from "../db.ts";
import { AudibleLibrary, type AudiobookEntry } from "../library.ts";
import {
  Converter,
  findConvertedChapters,
  getBookDirName,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_OUTPUT_FORMAT,
  isAudioFormat,
  isAudioQuality,
  BOOK_TAGS,
  CHAPTER_TAGS,
  type OutputFormat,
  type FormatRow,
} from "../converter.ts";
import {
  isOperationRunning,
  getActiveOperation,
  startOperation,
  clearOperation,
  cancelOperation,
  wasCancelled,
} from "../operations.ts";
import { sseJsonStream } from "./sse.ts";
import { runHelper, HelperUnavailableError } from "../pyhelper.ts";
import {
  setPendingLogin,
  getPendingLogin,
  clearPendingLogin,
} from "./pending-logins.ts";
import { zipStream, zipDirectoryEntries } from "./zip.ts";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { Context } from "hono";
import { getBookStatus } from "./book-status.ts";
import { versionLine } from "../version.ts";
import {
  hasUsers,
  listUsers,
  getUser,
  addUser,
  updateUser,
  verifyPassword,
  userHasPassword,
  runWithUser,
  currentUser,
  currentUserName,
  userDirs,
  setAudioSettings,
  setOutputFormat,
  setTableState,
  type TableState,
} from "../users.ts";
import { createSession, getSessionUser, destroySession } from "./sessions.ts";
import { desktopToken, DESKTOP_COOKIE } from "./desktop.ts";
import { isDesktopMode } from "../config.ts";
import { ensureDesktopUser } from "../users.ts";

export const routes = new Hono();

/** API requests get a JSON error; page requests keep their HTML redirect. */
function isApiPath(c: Context): boolean {
  return c.req.path.startsWith("/api/");
}

// Desktop mode: require the per-launch token before anything else. The
// launcher opens the app with ?token=..., which is then stored as a cookie.
routes.use("*", async (c, next) => {
  const token = desktopToken();
  if (!token) return next();

  if (getCookie(c, DESKTOP_COOKIE) === token) return next();

  if (c.req.query("token") === token) {
    setCookie(c, DESKTOP_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    if (c.req.method === "GET") {
      const url = new URL(c.req.url);
      url.searchParams.delete("token");
      return c.redirect(url.pathname + url.search);
    }
    return next();
  }

  if (isApiPath(c)) return c.json({ error: "Forbidden" }, 403);
  return c.text("Forbidden", 403);
});

// Strict CSP is possible because all client JS lives in /static/app.js —
// no inline handlers or script blocks. Inline <style> needs unsafe-inline.
routes.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
    },
  }),
);

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

function isValidAsin(asin: string): boolean {
  return ASIN_PATTERN.test(asin);
}

// --- Multi-tenant session handling ---
// When no users exist the app runs in legacy single-user mode (env-based
// paths, no login). As soon as the first user is created, every request
// must carry a valid session for one of the registered users.

const PUBLIC_PATHS = new Set(["/login"]);

/** POST /api/session (login) and POST /api/users (add) are how a session is
 * obtained in the first place, so they need session-free access. */
function isPublicApiWrite(c: Context): boolean {
  return (
    c.req.method === "POST" &&
    (c.req.path === "/api/session" || c.req.path === "/api/users")
  );
}

routes.use("*", async (c, next) => {
  // One implicit user, no login screen.
  if (isDesktopMode()) {
    return runWithUser(ensureDesktopUser(), () => next());
  }
  if (PUBLIC_PATHS.has(c.req.path) || isPublicApiWrite(c)) return next();
  if (!hasUsers()) return next();

  const userName = getSessionUser(getCookie(c, "session"));
  const user = userName ? getUser(userName) : undefined;
  if (!user) {
    // The SPA needs to read session state before it has one, to learn there
    // is no session yet rather than treating "not logged in" as an error.
    if (c.req.method === "GET" && c.req.path === "/api/session") return next();
    // A SPA fetch would silently follow a 302 and receive the login page with
    // status 200, so API paths get a real status code instead.
    if (isApiPath(c)) return c.json({ error: "Unauthorized" }, 401);
    return c.redirect("/login");
  }
  return runWithUser(user.name, () => next());
});

function userListEntries() {
  return listUsers().map((u) => ({ name: u.name, hasPassword: userHasPassword(u) }));
}

/** Per-request paths, activation bytes, and audio settings: user-scoped or legacy config. */
function requestPaths() {
  const user = currentUser();
  if (user) {
    const dirs = userDirs(user.name);
    return {
      targetDir: dirs.targetDir,
      outputDir: dirs.outputDir,
      activationBytes: user.activationBytes || config.activationBytes,
      audioSettings: user.audioSettings || DEFAULT_AUDIO_SETTINGS,
      outputFormat: user.outputFormat || DEFAULT_OUTPUT_FORMAT,
    };
  }
  return {
    targetDir: config.targetDir,
    outputDir: config.outputDir,
    activationBytes: config.activationBytes,
    audioSettings: DEFAULT_AUDIO_SETTINGS,
    outputFormat: DEFAULT_OUTPUT_FORMAT,
  };
}

interface BookMeta {
  convertibleAsins: Set<string>;
  convertedAsins: Map<string, number>;
}

/** One filesystem pass covering both "which downloaded books are ready to
 * convert" and "which are already converted, with how many chapters" — shared
 * by /api/books and /api/status so neither re-scans the output directory on
 * its own. */
function computeBookMeta(paths: ReturnType<typeof requestPaths>): BookMeta {
  let convertibleAsins = new Set<string>();
  try {
    const converter = new Converter(paths.targetDir, paths.outputDir, paths.activationBytes);
    convertibleAsins = new Set(converter.findBookFiles().map((b) => b.asin));
  } catch {
    // activation bytes or target dir may not be configured
  }
  const convertedAsins = new Map<string, number>();
  for (const book of getAllBooks()) {
    if (!book.downloaded_at) continue;
    const chapters = findConvertedChapters(paths.outputDir, book.asin, book.title || "", paths.outputFormat);
    if (chapters.length > 0) convertedAsins.set(book.asin, chapters.length);
  }
  return { convertibleAsins, convertedAsins };
}

function startUserSession(c: Context, userName: string): void {
  const token = createSession(userName);
  setCookie(c, "session", token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
}

// --- Account management: desktop mode has one implicit user, so none of
// --- this exists there. ---

/** GET /api/session stays available in desktop mode (it's how the SPA learns
 * there are no accounts to manage) — only the write endpoints are blocked. */
function isAccountManagementRequest(c: Context): boolean {
  if (c.req.path === "/login") return true;
  if (c.req.path === "/api/users" && c.req.method === "POST") return true;
  if (c.req.path === "/api/session" && c.req.method !== "GET") return true;
  return false;
}

routes.use("*", async (c, next) => {
  if (isDesktopMode() && isAccountManagementRequest(c)) {
    if (isApiPath(c)) return c.json({ error: "Not available in desktop mode" }, 404);
    return c.text("Not available in desktop mode", 404);
  }
  return next();
});

const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
  "<path d='M3 5c0 0 4-2 13 2v22c-9-4-13-2-13-2V5z' fill='%236c8cff'/>" +
  "<path d='M29 5c0 0-4-2-13 2v22c9-4 13-2 13-2V5z' fill='%238ba4ff'/></svg>";

/** The React client's shell — served for every app route (/, /login,
 * /user/settings). No inline script: the CSP is script-src 'self' with no
 * nonce, so all behavior lives in the external, committed /static/app.js
 * bundle (see docs/flatpak-plan.md — Flathub builds can't run a bundler, so
 * the built bundle ships as a checked-in file). */
function spaShell(c: Context): Response {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Audible Backup</title>
  <link rel="icon" href="${FAVICON}">
  <link rel="stylesheet" href="/static/app.css">
</head>
<body>
  <div id="root"></div>
  <script src="/static/app.js" defer></script>
</body>
</html>`);
}

routes.get("/login", (c) => spaShell(c));
routes.get("/user/settings", (c) => spaShell(c));
routes.get("/", (c) => spaShell(c));
routes.get("/library", (c) => c.redirect("/"));
routes.get("/convert", (c) => c.redirect("/"));

// --- Session ---

function sessionState(userName: string) {
  return { current: userName, others: userListEntries().filter((u) => u.name !== userName) };
}

routes.get("/api/session", (c) => {
  if (isDesktopMode()) return c.json({ desktop: true, current: null, others: [] });
  const name = currentUserName();
  if (!name) return c.json({ desktop: false, current: null, others: userListEntries(), legacy: !hasUsers() });
  return c.json({
    desktop: false,
    current: name,
    others: userListEntries().filter((u) => u.name !== name),
    legacy: false,
  });
});

routes.post("/api/session", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const record = body as { name?: unknown; password?: unknown } | null;
  const name = typeof record?.name === "string" ? record.name : "";
  const password = typeof record?.password === "string" ? record.password : "";

  const user = getUser(name);
  if (!user) return c.json({ error: "Unknown user" }, 400);
  if (userHasPassword(user) && !verifyPassword(user, password)) {
    return c.json({ error: "Wrong password" }, 401);
  }

  startUserSession(c, user.name);
  return c.json(sessionState(user.name));
});

routes.delete("/api/session", (c) => {
  destroySession(getCookie(c, "session"));
  deleteCookie(c, "session", { path: "/" });
  return c.body(null, 204);
});

routes.post("/api/users", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const record = body as { name?: unknown; password?: unknown; activationBytes?: unknown } | null;
  const name = typeof record?.name === "string" ? record.name.trim() : "";
  const password = typeof record?.password === "string" ? record.password : "";
  const activationBytes = typeof record?.activationBytes === "string" ? record.activationBytes : "";

  try {
    const user = addUser(name, password || undefined, activationBytes || undefined);
    startUserSession(c, user.name);
    return c.json(sessionState(user.name), 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

// --- Settings ---

interface AudibleStatus {
  /** Whether the Python helper can run at all (sign-in needs it). */
  available: boolean;
  linked: boolean;
  marketplace?: string;
  /** Set while a sign-in is in progress and awaiting the pasted URL. */
  pending?: { url: string; marketplace: string };
}

/** Whether this user's config dir is linked to Audible, via the helper. */
async function audibleStatus(): Promise<AudibleStatus> {
  const pending = getPendingLogin(currentUserName());
  try {
    const done = await runHelper(["login-status"]);
    return {
      available: true,
      linked: done.linked === true,
      marketplace: (done.marketplace as string) || undefined,
      pending: pending ? { url: pending.url, marketplace: pending.marketplace } : undefined,
    };
  } catch (err) {
    if (err instanceof HelperUnavailableError) {
      return { available: false, linked: false };
    }
    return {
      available: true,
      linked: false,
      pending: pending ? { url: pending.url, marketplace: pending.marketplace } : undefined,
    };
  }
}

async function settingsState(user: NonNullable<ReturnType<typeof currentUser>>) {
  return {
    userName: user.name,
    activationBytes: user.activationBytes || "",
    hasPassword: userHasPassword(user),
    audible: await audibleStatus(),
    desktop: isDesktopMode(),
    audioSettings: user.audioSettings || DEFAULT_AUDIO_SETTINGS,
    outputFormat: user.outputFormat || DEFAULT_OUTPUT_FORMAT,
    version: versionLine(),
  };
}

routes.get("/api/settings", async (c) => {
  const user = currentUser();
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await settingsState(user));
});

const VALID_TAG_KEYS = new Set([...BOOK_TAGS, ...CHAPTER_TAGS].map((t) => t.key));
const CHAPTER_TAG_KEYS = new Set(CHAPTER_TAGS.map((t) => t.key));

/** Chapter tags (e.g. {Chapter #}) only make sense per-chapter, so they're
 * rejected outside the filename row even if a tampered request includes one. */
function parseFormatRow(raw: unknown, allowChapterTags: boolean): FormatRow | null {
  if (!Array.isArray(raw)) return null;
  const row: FormatRow = [];
  for (const seg of raw.slice(0, 30)) {
    if (!seg || typeof seg !== "object") continue;
    const type = (seg as Record<string, unknown>).type;
    const value = (seg as Record<string, unknown>).value;
    if (typeof value !== "string") continue;
    if (type === "tag" && VALID_TAG_KEYS.has(value) && (allowChapterTags || !CHAPTER_TAG_KEYS.has(value))) {
      row.push({ type: "tag", value });
    } else if (type === "text") {
      row.push({ type: "text", value: value.slice(0, 200) });
    }
  }
  return row;
}

/** The shared validator: a tag allowlist, 30 segments/row, 10 directory
 * rows, 200-char text. */
function parseOutputFormatObject(data: unknown): OutputFormat | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.directory)) return null;

  const directory: FormatRow[] = [];
  for (const rowRaw of record.directory.slice(0, 10)) {
    const row = parseFormatRow(rowRaw, false);
    if (row) directory.push(row);
  }
  const filename = parseFormatRow(record.filename, true);
  if (!filename) return null;
  return { directory, filename };
}

routes.patch("/api/settings", async (c) => {
  const user = currentUser();
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const record = body as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return c.json({ error: "Invalid JSON" }, 400);

  updateUser(user.name, {
    activationBytes: typeof record.activationBytes === "string" ? record.activationBytes : "",
    password: typeof record.password === "string" && record.password ? record.password : undefined,
    removePassword: record.removePassword === true,
  });

  const format = record.audioFormat;
  const quality = record.audioQuality;
  if (isAudioFormat(format) && isAudioQuality(quality)) {
    const customArgs = typeof record.audioArgs === "string" ? record.audioArgs.trim() : "";
    setAudioSettings(user.name, {
      format,
      quality,
      ...(record.audioCustomEnabled === true && customArgs ? { customArgs } : {}),
    });
  }

  if (record.outputFormat !== undefined) {
    const parsed = parseOutputFormatObject(record.outputFormat);
    if (!parsed) return c.json({ error: "Invalid output format" }, 400);
    setOutputFormat(user.name, parsed);
  }

  // Mutations above went through their own listUsers() reads, so the `user`
  // captured before them is stale — refetch for the response.
  const updated = currentUser();
  if (!updated) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await settingsState(updated));
});

// --- Audible sign-in (two steps; the password is entered on Audible's site) ---

routes.post("/api/audible/login-url", async (c) => {
  const user = currentUser();
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // marketplace defaults below when the body is empty/absent
  }
  const marketplace =
    typeof (body as { marketplace?: unknown } | null)?.marketplace === "string"
      ? (body as { marketplace: string }).marketplace
      : "de";

  try {
    const done = await runHelper(["login-url", marketplace]);
    if (!done.ok) {
      return c.json({ error: done.message || "Could not start sign-in" }, 400);
    }
    setPendingLogin(user.name, {
      marketplace: String(done.marketplace || marketplace),
      serial: String(done.serial),
      codeVerifier: String(done.code_verifier),
      url: String(done.url),
    });
    return c.json({ url: String(done.url), marketplace: String(done.marketplace || marketplace) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Could not start sign-in: ${msg}` }, 400);
  }
});

routes.post("/api/audible/login-complete", async (c) => {
  const user = currentUser();
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const pending = getPendingLogin(user.name);
  if (!pending) return c.json({ error: "Sign-in expired — please start again." }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const redirectUrl =
    typeof (body as { redirectUrl?: unknown } | null)?.redirectUrl === "string"
      ? (body as { redirectUrl: string }).redirectUrl.trim()
      : "";
  if (!/^https?:\/\//i.test(redirectUrl)) {
    return c.json({ error: "Paste the full address, including https://" }, 400);
  }

  try {
    const done = await runHelper([
      "login-complete",
      pending.marketplace,
      pending.serial,
      pending.codeVerifier,
      redirectUrl,
    ]);
    if (!done.ok) {
      return c.json({ error: done.message || "Sign-in failed" }, 400);
    }
    clearPendingLogin(user.name);
    // The client calls the sync endpoint itself once this resolves — a
    // freshly-connected account is otherwise empty until the user remembers
    // to sync.
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Sign-in failed: ${msg}` }, 400);
  }
});

routes.delete("/api/audible/pending", (c) => {
  const user = currentUser();
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  clearPendingLogin(user.name);
  return c.body(null, 204);
});

routes.post("/api/library/reset", (c) => {
  const user = currentUser();
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (isOperationRunning()) {
    return c.json({ error: "An operation is running — wait for it to finish first." }, 409);
  }
  resetDatabase();
  return c.body(null, 204);
});

/**
 * Desktop only: reveal the finished audiobooks in the user's file manager.
 * Inside Flatpak `xdg-open` is the portal shim, so this asks the host to open
 * the folder rather than reaching out of the sandbox itself.
 */
routes.post("/open-output", async (c) => {
  if (!isDesktopMode()) return c.notFound();

  const dir = requestPaths().outputDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return c.text("Could not create the output folder", 500);
  }

  // Waiting for the spawn to succeed costs a moment but is the difference
  // between "opened" and "silently did nothing" when xdg-open is missing.
  const opened = await new Promise<boolean>((resolve) => {
    const child = spawn("xdg-open", [dir], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });

  return opened ? c.body(null, 204) : c.text("Could not open the folder", 500);
});

// --- Table state (sorting/filters/visibility/order/sizing/selection) ---
// One opaque JSON snapshot of the table library's own state. Saved per
// account rather than relying on localStorage: the desktop app binds to a
// fresh OS-assigned port every launch, so browser storage (scoped to that
// origin) would otherwise reset on every restart.

const MAX_TABLE_STATE_BYTES = 64_000;

routes.get("/api/table-state", (c) => {
  const user = currentUser();
  if (!user) return c.json({}); // legacy mode: nothing saved
  return c.json(user.tableState || {});
});

routes.post("/api/table-state", async (c) => {
  const user = currentUser();
  if (!user) return c.body(null, 204); // legacy mode: nothing to attach this to

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Expected a JSON object" }, 400);
  }
  if (JSON.stringify(body).length > MAX_TABLE_STATE_BYTES) {
    return c.json({ error: "Table state payload too large" }, 400);
  }

  setTableState(user.name, body as TableState);
  return c.body(null, 204);
});

// --- JSON API ---

routes.get("/api/status", (c) => {
  const paths = requestPaths();
  const { convertedAsins } = computeBookMeta(paths);
  const all = getAllAudiobooks();
  const downloaded = getDownloadedAsins();
  let convertedCount = 0;
  for (const asin of downloaded) {
    if (convertedAsins.has(asin)) convertedCount++;
  }
  return c.json({
    total: all.length,
    downloaded: downloaded.size,
    converted: convertedCount,
    pending: downloaded.size - convertedCount,
  });
});

// Includes ignored books and adds the derived `status` and `chapterCount`
// fields the table renders — and drops `aax_path`, an absolute server
// filesystem path with no business leaving the server.
routes.get("/api/books", (c) => {
  const paths = requestPaths();
  const { convertibleAsins, convertedAsins } = computeBookMeta(paths);
  const books = getAllBooks().map((book) => {
    const { aax_path, ...rest } = book;
    return {
      ...rest,
      status: getBookStatus(book, convertibleAsins, convertedAsins),
      chapterCount: convertedAsins.get(book.asin) ?? null,
    };
  });
  return c.json(books);
});

// --- Ignore / Unignore ---

routes.post("/api/ignore/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.json({ error: "Invalid ASIN" }, 400);
  ignoreBook(asin);
  return c.body(null, 204);
});

routes.post("/api/unignore/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.json({ error: "Invalid ASIN" }, 400);
  unignoreBook(asin);
  return c.body(null, 204);
});

routes.post("/api/delete/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.json({ error: "Invalid ASIN" }, 400);
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
    const deletePaths = requestPaths();
    const bookDir = path.join(deletePaths.outputDir, getBookDirName(asin, book.title || "", deletePaths.outputFormat));
    if (fs.existsSync(bookDir)) {
      fs.rmSync(bookDir, { recursive: true, force: true });
    }
    // Reset DB fields
    deleteBook(asin);
  }

  return c.body(null, 204);
});

// --- Downloads to the browser ---

function attachmentHeaders(filename: string, contentType: string): Record<string, string> {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
}

routes.get("/download/converted/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.text("Invalid ASIN", 400);

  const book = getAudiobookByAsin(asin);
  const paths = requestPaths();
  const bookDir = book ? path.join(paths.outputDir, getBookDirName(asin, book.title || "", paths.outputFormat)) : "";
  if (!book || findConvertedChapters(paths.outputDir, asin, book.title || "", paths.outputFormat).length === 0) {
    return c.text("No converted files for this book", 404);
  }

  const entries = zipDirectoryEntries(bookDir);
  if (entries.length === 0) {
    return c.text("No converted files for this book", 404);
  }

  const zipName = `${path.basename(bookDir)}.zip`;
  const body = Readable.toWeb(
    Readable.from(zipStream(entries)),
  ) as ReadableStream;
  return new Response(body, {
    headers: attachmentHeaders(zipName, "application/zip"),
  });
});

routes.get("/download/aax/:asin", (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.text("Invalid ASIN", 400);

  const book = getAudiobookByAsin(asin);
  if (!book?.aax_path || !fs.existsSync(book.aax_path)) {
    return c.text("No AAX file for this book", 404);
  }

  const stat = fs.statSync(book.aax_path);
  const contentType = book.aax_path.endsWith(".aaxc")
    ? "application/octet-stream"
    : "audio/vnd.audible.aax";
  const body = Readable.toWeb(
    fs.createReadStream(book.aax_path),
  ) as ReadableStream;
  return new Response(body, {
    headers: {
      ...attachmentHeaders(path.basename(book.aax_path), contentType),
      "Content-Length": String(stat.size),
    },
  });
});

// --- Sync ---

routes.post("/api/sync", (c) => {
  if (isOperationRunning()) return c.json({ error: "An operation is already running" }, 409);

  const reporter = startOperation("sync");
  const library = new AudibleLibrary(requestPaths().targetDir, reporter);
  library
    .sync()
    .then(() => reporter.done({ success: true, summary: "Sync complete" }))
    .catch((err: Error) => reporter.done({ success: false, summary: failureSummary(err) }))
    .finally(() => clearOperation());

  return c.json({ type: "sync", queued: [] });
});

/** An operation's stream is only visible to the user who started it. */
function ownsOperation(op: { user?: string }): boolean {
  return !op.user || op.user === currentUserName();
}

// Lets the SPA know, on mount or after a reload, whether to re-attach to an
// in-flight operation's stream.
routes.get("/api/operation", (c) => {
  const op = getActiveOperation();
  if (!op || op.finished || !ownsOperation(op)) {
    return c.json({ running: false });
  }
  return c.json({ running: true, type: op.type });
});

// One global active operation (see operations.ts), so one stream serves
// whatever is running. Deliberately does NOT exclude a just-finished
// operation (unlike GET /api/operation above) — clearOperation() keeps it
// around for a few seconds precisely so a client connecting right after a
// fast operation finishes (POST returns, then the client opens this stream)
// still gets its buffered events via reporter.replay(), including "done".
routes.get("/api/operation/stream", (c) => {
  const op = getActiveOperation();
  if (!op || !ownsOperation(op)) {
    return c.json({ error: "No active operation" }, 404);
  }
  return sseJsonStream(c, op.reporter);
});

// --- Download ---

routes.post("/api/download", async (c) => {
  if (isOperationRunning()) return c.json({ error: "An operation is already running" }, 409);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // no body: falls back to "every not-yet-downloaded book" below
  }
  const record = body as { asins?: unknown; force?: unknown } | null;
  let asins: string[] = [];
  if (Array.isArray(record?.asins)) {
    asins = record.asins.filter((a): a is string => typeof a === "string");
    if (!asins.every(isValidAsin)) return c.json({ error: "Invalid ASIN" }, 400);
  }
  const force = record?.force === true;

  const reporter = startOperation("download");
  const library = new AudibleLibrary(requestPaths().targetDir, reporter);

  let books: AudiobookEntry[];
  if (asins.length > 0) {
    books = asins.map((asin) => {
      const row = getAudiobookByAsin(asin);
      return { asin, author: row?.author || "", title: row?.title || asin, fullLine: "" };
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
    .catch((err: Error) => reporter.done({ success: false, summary: failureSummary(err) }))
    .finally(() => clearOperation());

  return c.json({ type: "download", queued: books.map((b) => b.asin) });
});

// --- Download All / Download Selected: fetch not-yet-downloaded books, then
// --- convert everything that's ready — one operation, so "download" always
// --- means fully processed, the same as the one-click Download button.
// --- With no ASINs, this is "Download All"; with some, it's the scoped
// --- "Download Selected" run.

routes.post("/api/download-all", async (c) => {
  if (isOperationRunning()) return c.json({ error: "An operation is already running" }, 409);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // no body: falls back to "every not-yet-downloaded book" below
  }
  const record = body as { asins?: unknown } | null;
  let selected: string[] | undefined;
  if (Array.isArray(record?.asins)) {
    selected = record.asins.filter((a): a is string => typeof a === "string");
    if (!selected.every(isValidAsin)) return c.json({ error: "Invalid ASIN" }, 400);
  }
  const selectedAsins = selected ? new Set(selected) : undefined;

  const paths = requestPaths();
  const notDownloaded = getNotDownloadedBooks().filter(
    (row) => !selectedAsins || selectedAsins.has(row.asin),
  );
  const downloadBooks: AudiobookEntry[] = notDownloaded.map((row) => ({
    asin: row.asin,
    author: row.author || "",
    title: row.title || row.asin,
    fullLine: "",
  }));

  // Books already downloaded but not yet converted can be reported queued
  // right away; freshly downloaded ones only become convertible once the
  // download step lands their files, so the client learns their real status
  // from the usual /api/books refresh once the operation finishes.
  let alreadyDownloadedQueued: string[] = [];
  try {
    const converter = new Converter(paths.targetDir, paths.outputDir, paths.activationBytes);
    const ignoredAsins = getIgnoredAsins();
    alreadyDownloadedQueued = converter
      .findBookFiles()
      .filter(
        (b) =>
          !ignoredAsins.has(b.asin) &&
          (!selectedAsins || selectedAsins.has(b.asin)) &&
          findConvertedChapters(paths.outputDir, b.asin, b.bookTitle, paths.outputFormat).length === 0,
      )
      .map((b) => b.asin);
  } catch {
    // activation bytes or target dir may not be configured yet
  }

  const reporter = startOperation("download-all");
  const library = new AudibleLibrary(paths.targetDir, reporter);

  const run = async (): Promise<void> => {
    if (downloadBooks.length > 0) {
      await library.downloadBooks(downloadBooks, false);
    }
    const converter = new Converter(
      paths.targetDir,
      paths.outputDir,
      paths.activationBytes,
      reporter,
      false,
      paths.audioSettings,
      paths.outputFormat,
    );
    await converter.convertAll(selectedAsins);
  };

  run()
    .then(() => reporter.done({ success: true, summary: "Download complete" }))
    .catch((err: Error) => reporter.done({ success: false, summary: failureSummary(err) }))
    .finally(() => clearOperation());

  return c.json({
    type: "download-all",
    queued: [...downloadBooks.map((b) => b.asin), ...alreadyDownloadedQueued],
  });
});

// --- Convert Single ---

routes.post("/api/convert/:asin", async (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.json({ error: "Invalid ASIN" }, 400);
  if (isOperationRunning()) return c.json({ error: "An operation is already running" }, 409);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // force defaults to false below
  }
  const force = (body as { force?: unknown } | null)?.force === true;

  const reporter = startOperation("convert");

  try {
    const paths = requestPaths();
    const converter = new Converter(
      paths.targetDir,
      paths.outputDir,
      paths.activationBytes,
      reporter,
      force,
      paths.audioSettings,
      paths.outputFormat,
    );
    const books = converter.findBookFiles();
    const book = books.find((b) => b.asin === asin);

    if (!book) {
      clearOperation();
      return c.json({ error: `Book with ASIN ${asin} not found` }, 404);
    }

    converter
      .convertBook(book.aaxFile, book.chapterFile, book.asin, book.bookTitle, book.bookCover, book.voucherFile)
      .then((success) =>
        reporter.done({
          success,
          summary: success
            ? `Successfully converted ${book.bookTitle || asin}`
            : `Failed to convert ${book.bookTitle || asin}`,
        }),
      )
      .catch((err: Error) => reporter.done({ success: false, summary: failureSummary(err) }))
      .finally(() => clearOperation());

    return c.json({ type: "convert", queued: [asin] });
  } catch (err) {
    clearOperation();
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

/** A cancelled run should say so, not surface the killed child's error. */
function failureSummary(err: Error): string {
  return wasCancelled() ? "Cancelled" : err.message;
}

routes.post("/api/operation/cancel", (c) => {
  const op = getActiveOperation();
  if (!op || op.finished || !ownsOperation(op)) {
    return c.json({ error: "No operation to cancel" }, 404);
  }
  cancelOperation();
  return c.json({ ok: true });
});

// --- One-click: fetch from Audible if needed, convert if needed, then hand
// --- the finished ZIP to the browser.

routes.post("/api/prepare/:asin", async (c) => {
  const asin = c.req.param("asin");
  if (!isValidAsin(asin)) return c.json({ error: "Invalid ASIN" }, 400);
  if (isOperationRunning()) return c.json({ error: "An operation is already running" }, 409);

  const paths = requestPaths();
  const reporter = startOperation("prepare");

  const run = async (): Promise<void> => {
    const row = getAudiobookByAsin(asin);

    if (!row?.downloaded_at) {
      const library = new AudibleLibrary(paths.targetDir, reporter);
      const ok = await library.downloadBook(asin, row?.author || "", row?.title || asin, false);
      if (!ok) throw new Error("Could not download this book from Audible");
    }

    const converter = new Converter(
      paths.targetDir,
      paths.outputDir,
      paths.activationBytes,
      reporter,
      false,
      paths.audioSettings,
      paths.outputFormat,
    );
    const book = converter.findBookFiles().find((b) => b.asin === asin);
    if (!book) {
      throw new Error("Downloaded files for this book were not found, so it cannot be converted");
    }
    const ok = await converter.convertBook(
      book.aaxFile,
      book.chapterFile,
      book.asin,
      book.bookTitle,
      book.bookCover,
      book.voucherFile,
    );
    if (!ok) throw new Error("Conversion failed");
  };

  run()
    .then(() =>
      reporter.done({
        success: true,
        // A desktop install already wrote the MP3s to the user's music folder,
        // so pulling the same files back through a ZIP would be busywork.
        ...(isDesktopMode()
          ? { summary: `Saved to ${paths.outputDir}` }
          : { summary: "Ready — your download is starting", downloadUrl: `/download/converted/${asin}` }),
      }),
    )
    .catch((err: Error) => reporter.done({ success: false, summary: failureSummary(err) }))
    .finally(() => clearOperation());

  return c.json({ type: "prepare", queued: [asin] });
});
