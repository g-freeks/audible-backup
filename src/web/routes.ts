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
import { sseStream } from "./sse.ts";
import { booksPage } from "./templates/books.ts";
import { loginPage, settingsPage, type AudibleStatus } from "./templates/user.ts";
import { runHelper, HelperUnavailableError } from "../pyhelper.ts";
import {
  setPendingLogin,
  getPendingLogin,
  clearPendingLogin,
} from "./pending-logins.ts";
import type { UserNav } from "./templates/layout.ts";
import { zipStream, zipDirectoryEntries } from "./zip.ts";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { Context } from "hono";
import { escapeHtml } from "./templates/html.ts";
import { getBookStatus } from "./book-status.ts";
import { versionLine } from "../version.ts";
import { queuedSwap } from "./templates/components.ts";
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
  setColumnPrefs,
  setAudioSettings,
  setOutputFormat,
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

const PUBLIC_PATHS = new Set(["/login", "/user/switch", "/user/add"]);

/** POST /api/session (login) and POST /api/users (add) are how a session is
 * obtained in the first place — the JSON equivalents of /user/switch and
 * /user/add above, so they need the same session-free access. */
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
 * by the books page, the /api/books listing and /api/status so none of them
 * re-scan the output directory on their own. */
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

function buildUserNav(): UserNav {
  if (isDesktopMode()) return { others: [], desktop: true };
  const name = currentUserName();
  if (!name) return { others: [] };
  return {
    current: name,
    others: userListEntries().filter((u) => u.name !== name),
  };
}

function startUserSession(c: Context, userName: string): void {
  const token = createSession(userName);
  setCookie(c, "session", token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
}

// --- User routes ---

const ACCOUNT_PATHS = ["/login", "/user/switch", "/user/add", "/user/logout"];

/** GET /api/session stays available in desktop mode (it's how the SPA learns
 * there are no accounts to manage) — only the write endpoints that manage
 * accounts are blocked, matching the form routes above. */
function isAccountManagementRequest(c: Context): boolean {
  if (ACCOUNT_PATHS.includes(c.req.path)) return true;
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

routes.get("/login", (c) => {
  const preselect = c.req.query("user");
  return c.html(loginPage(userListEntries(), undefined, preselect));
});

routes.post("/user/switch", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name || "");
  const password = String(body.password || "");

  const user = getUser(name);
  if (!user) {
    return c.html(loginPage(userListEntries(), "Unknown user"), 400);
  }
  if (userHasPassword(user) && !verifyPassword(user, password)) {
    return c.html(loginPage(userListEntries(), "Wrong password", name), 401);
  }

  startUserSession(c, user.name);
  return c.redirect("/");
});

routes.post("/user/add", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const password = String(body.password || "");
  const activationBytes = String(body.activation_bytes || "");

  try {
    const user = addUser(name, password || undefined, activationBytes || undefined);
    startUserSession(c, user.name);
    return c.redirect("/");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(loginPage(userListEntries(), msg), 400);
  }
});

routes.post("/user/logout", (c) => {
  destroySession(getCookie(c, "session"));
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/login");
});

// --- JSON equivalents, for the SPA ---

function sessionState(userName: string) {
  return { current: userName, others: userListEntries().filter((u) => u.name !== userName) };
}

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

async function renderSettings(
  c: Context,
  extra: { message?: string; error?: string } = {},
  status?: number,
): Promise<Response> {
  const user = currentUser();
  if (!user) return c.redirect("/login");
  const html = settingsPage({
    userName: user.name,
    activationBytes: user.activationBytes || "",
    hasPassword: userHasPassword(user),
    audible: await audibleStatus(),
    userNav: buildUserNav(),
    desktop: isDesktopMode(),
    operationRunning: currentOperationRunning(),
    audioSettings: user.audioSettings || DEFAULT_AUDIO_SETTINGS,
    outputFormat: user.outputFormat || DEFAULT_OUTPUT_FORMAT,
    ...extra,
  });
  return status ? c.html(html, status as 400) : c.html(html);
}

routes.get("/user/settings", (c) => renderSettings(c));

// --- Session / settings state, as JSON (for the SPA) ---

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

routes.get("/api/settings", async (c) => {
  const user = currentUser();
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json({
    userName: user.name,
    activationBytes: user.activationBytes || "",
    hasPassword: userHasPassword(user),
    audible: await audibleStatus(),
    desktop: isDesktopMode(),
    audioSettings: user.audioSettings || DEFAULT_AUDIO_SETTINGS,
    outputFormat: user.outputFormat || DEFAULT_OUTPUT_FORMAT,
    version: versionLine(),
  });
});

// --- Audible sign-in (two steps; the password is entered on Audible's site) ---

routes.post("/user/audible/start", async (c) => {
  const user = currentUser();
  if (!user) return c.redirect("/login");

  const body = await c.req.parseBody();
  const marketplace = String(body.marketplace || "de");

  try {
    const done = await runHelper(["login-url", marketplace]);
    if (!done.ok) {
      return renderSettings(c, { error: done.message || "Could not start sign-in" }, 400);
    }
    setPendingLogin(user.name, {
      marketplace: String(done.marketplace || marketplace),
      serial: String(done.serial),
      codeVerifier: String(done.code_verifier),
      url: String(done.url),
    });
    return renderSettings(c);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderSettings(c, { error: `Could not start sign-in: ${msg}` }, 400);
  }
});

routes.post("/user/audible/complete", async (c) => {
  const user = currentUser();
  if (!user) return c.redirect("/login");

  const pending = getPendingLogin(user.name);
  if (!pending) {
    return renderSettings(c, { error: "Sign-in expired — please start again." }, 400);
  }

  const body = await c.req.parseBody();
  const redirectUrl = String(body.redirect_url || "").trim();
  if (!/^https?:\/\//i.test(redirectUrl)) {
    return renderSettings(c, { error: "Paste the full address, including https://" }, 400);
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
      return renderSettings(c, { error: done.message || "Sign-in failed" }, 400);
    }
    clearPendingLogin(user.name);
    // Head straight to the library and let it kick off a sync itself (see the
    // `sync=1` handling on GET /) — a freshly-connected account is otherwise
    // an empty library until the user remembers to click Sync Library.
    return c.redirect("/?sync=1");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return renderSettings(c, { error: `Sign-in failed: ${msg}` }, 400);
  }
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

routes.post("/user/reset-db", (c) => {
  const user = currentUser();
  if (!user) return c.redirect("/login");
  if (isOperationRunning()) {
    return renderSettings(
      c,
      { error: "An operation is running — wait for it to finish first." },
      400,
    );
  }
  resetDatabase();
  return renderSettings(c, {
    message: "Library database reset. Files on disk were kept.",
  });
});

routes.post("/user/audible/cancel", (c) => {
  clearPendingLogin(currentUserName());
  return renderSettings(c);
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

function parseOutputFormat(raw: string): OutputFormat | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
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

routes.post("/user/settings", async (c) => {
  const user = currentUser();
  if (!user) return c.redirect("/login");

  const body = await c.req.parseBody();
  updateUser(user.name, {
    activationBytes: String(body.activation_bytes ?? ""),
    password: String(body.password || "") || undefined,
    removePassword: body.remove_password === "true",
  });

  const format = body.audio_format;
  const quality = body.audio_quality;
  if (isAudioFormat(format) && isAudioQuality(quality)) {
    const customEnabled = body.audio_custom_enabled === "true";
    const customArgs = String(body.audio_args || "").trim();
    setAudioSettings(user.name, {
      format,
      quality,
      ...(customEnabled && customArgs ? { customArgs } : {}),
    });
  }

  if (typeof body.output_format_json === "string") {
    const parsed = parseOutputFormat(body.output_format_json);
    if (parsed) setOutputFormat(user.name, parsed);
  }

  return renderSettings(c, { message: "Settings saved" });
});

// --- Pages ---

routes.get("/", (c) => {
  const paths = requestPaths();
  const { convertibleAsins, convertedAsins } = computeBookMeta(paths);
  return c.html(booksPage(convertibleAsins, convertedAsins, buildUserNav(), {
    autoSync: c.req.query("sync") === "1",
    operationRunning: currentOperationRunning(),
    columnPrefs: currentUser()?.columnPrefs,
  }));
});
routes.get("/library", (c) => c.redirect("/"));
routes.get("/convert", (c) => c.redirect("/"));

// --- Column prefs (visibility + drag order) ---
// Saved per account rather than relying on localStorage: the desktop app
// binds to a fresh OS-assigned port every launch, so browser storage (scoped
// to that origin) would otherwise reset on every restart.

routes.post("/api/column-prefs", async (c) => {
  const user = currentUser();
  if (!user) return c.body(null, 204); // legacy mode: nothing to attach this to

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON", 400);
  }
  const record = body as { hidden?: unknown; order?: unknown } | null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  setColumnPrefs(user.name, {
    hidden: strings(record?.hidden),
    order: strings(record?.order),
  });
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

// Includes ignored books (unlike /api/status) and adds the derived `status`
// and `chapterCount` fields the HTML table renders today — and drops
// `aax_path`, an absolute server filesystem path with no business leaving
// the server.
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

routes.post("/library/sync", (c) => {
  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const reporter = startOperation("sync");

  const library = new AudibleLibrary(requestPaths().targetDir, reporter);
  library
    .sync()
    .then(() => reporter.done({ success: true, summary: "Sync complete" }))
    .catch((err: Error) =>
      reporter.done({ success: false, summary: failureSummary(err) }),
    )
    .finally(() => clearOperation());

  return c.html(logPanel("/library/sync/stream", "Sync started..."));
});

/** An operation's stream is only visible to the user who started it. */
function ownsOperation(op: { user?: string }): boolean {
  return !op.user || op.user === currentUserName();
}

/**
 * Whether an operation the current user can watch is in flight — used to
 * render the topbar's log indicator correctly on first paint, since an
 * operation started without a click on the current page (e.g. an auto-sync
 * right after connecting Audible) never fires the client-side mutation that
 * would otherwise flip it on.
 */
function currentOperationRunning(): boolean {
  const op = getActiveOperation();
  return !!op && !op.finished && ownsOperation(op);
}

// Lets the SPA know, on mount or after a reload, whether to re-attach to an
// in-flight operation's stream — the job currentOperationRunning() does for
// the topbar's log dot in the server-rendered page.
routes.get("/api/operation", (c) => {
  const op = getActiveOperation();
  if (!op || op.finished || !ownsOperation(op)) {
    return c.json({ running: false });
  }
  return c.json({ running: true, type: op.type });
});

routes.get("/library/sync/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "sync" || !ownsOperation(op)) {
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

  const library = new AudibleLibrary(requestPaths().targetDir, reporter);

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
      reporter.done({ success: false, summary: failureSummary(err) }),
    )
    .finally(() => clearOperation());

  const oobSwaps = books.map((b) => queuedSwap(b.asin)).join("");

  return c.html(logPanel("/library/download/stream", "Download started...", oobSwaps));
});

routes.get("/library/download/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "download" || !ownsOperation(op)) {
    return c.text("No active download operation", 404);
  }
  return sseStream(c, op.reporter);
});

// --- Download All / Download Selected: fetch not-yet-downloaded books, then
// --- convert everything that's ready — one operation, so "download" always
// --- means fully processed, the same as the one-click Download button.
// --- With no ASINs, this is "Download All"; with some, it's the scoped
// --- "Download Selected" run.

routes.post("/library/download-all", async (c) => {
  if (isOperationRunning()) {
    return c.html(
      '<div class="log-panel"><div class="log-line warn">An operation is already running. Please wait for it to complete.</div></div>',
      409,
    );
  }

  const body = await c.req.parseBody({ all: true });
  let selected: string[] | undefined;
  if (body.asin) {
    selected = Array.isArray(body.asin) ? body.asin as string[] : [body.asin as string];
    if (!selected.every(isValidAsin)) {
      return c.html(
        '<div class="log-panel"><div class="log-line error">Invalid ASIN</div></div>',
        400,
      );
    }
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

  // Books already downloaded but not yet converted can be marked queued right
  // away; freshly downloaded ones only become convertible once the download
  // step lands their files, so they pick up their real status when the
  // finished operation triggers the usual books-table refresh.
  let alreadyDownloadedQueuedSwaps = "";
  try {
    const converter = new Converter(paths.targetDir, paths.outputDir, paths.activationBytes);
    const ignoredAsins = getIgnoredAsins();
    const queued = converter.findBookFiles().filter((b) =>
      !ignoredAsins.has(b.asin) &&
      (!selectedAsins || selectedAsins.has(b.asin)) &&
      findConvertedChapters(paths.outputDir, b.asin, b.bookTitle, paths.outputFormat).length === 0,
    );
    alreadyDownloadedQueuedSwaps = queued.map((b) => queuedSwap(b.asin)).join("");
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
    .catch((err: Error) =>
      reporter.done({ success: false, summary: failureSummary(err) }),
    )
    .finally(() => clearOperation());

  const oobSwaps = downloadBooks.map((b) => queuedSwap(b.asin)).join("") + alreadyDownloadedQueuedSwaps;

  return c.html(logPanel("/library/download-all/stream", "Download started...", oobSwaps));
});

routes.get("/library/download-all/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "download-all" || !ownsOperation(op)) {
    return c.text("No active operation", 404);
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

    const ignoredAsins = getIgnoredAsins();
    const queuedBooks = converter.findBookFiles().filter((b) =>
      !ignoredAsins.has(b.asin) &&
      (force || findConvertedChapters(paths.outputDir, b.asin, b.bookTitle, paths.outputFormat).length === 0)
    );
    const oobSwaps = queuedBooks.map((b) => queuedSwap(b.asin)).join("");

    converter
      .convertAll()
      .then(() =>
        reporter.done({ success: true, summary: "Conversion complete" }),
      )
      .catch((err: Error) =>
        reporter.done({ success: false, summary: failureSummary(err) }),
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
        book.voucherFile,
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
        reporter.done({ success: false, summary: failureSummary(err) }),
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

/** A cancelled run should say so, not surface the killed child's error. */
function failureSummary(err: Error): string {
  return wasCancelled() ? "Cancelled" : err.message;
}

/** Registered under both the legacy path (used by the HTMX UI's fetch call)
 * and /api/ (for the SPA) — same behavior, JSON only for the /api/ path. */
function handleCancelOperation(c: Context) {
  const op = getActiveOperation();
  if (!op || op.finished || !ownsOperation(op)) {
    return isApiPath(c) ? c.json({ error: "No operation to cancel" }, 404) : c.text("No operation to cancel", 404);
  }
  cancelOperation();
  return isApiPath(c) ? c.json({ ok: true }) : c.text("Cancelling");
}

routes.post("/operation/cancel", handleCancelOperation);
routes.post("/api/operation/cancel", handleCancelOperation);

// --- One-click: fetch from Audible if needed, convert if needed, then hand
// --- the finished ZIP to the browser.

routes.post("/prepare/:asin", async (c) => {
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

  const paths = requestPaths();
  const reporter = startOperation("prepare");

  const run = async (): Promise<void> => {
    const row = getAudiobookByAsin(asin);

    if (!row?.downloaded_at) {
      const library = new AudibleLibrary(paths.targetDir, reporter);
      const ok = await library.downloadBook(
        asin,
        row?.author || "",
        row?.title || asin,
        false,
      );
      if (!ok) throw new Error("Could not download this book from Audible");
    }

    // convertBook itself is a cheap no-op if the book's output directory
    // already has chapter files, so no need to pre-check here — that also
    // avoids guessing at a title before we've resolved the actual filename.
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
      throw new Error(
        "Downloaded files for this book were not found, so it cannot be converted",
      );
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
          : {
              summary: "Ready — your download is starting",
              downloadUrl: `/download/converted/${asin}`,
            }),
      }),
    )
    .catch((err: Error) =>
      reporter.done({ success: false, summary: failureSummary(err) }),
    )
    .finally(() => clearOperation());

  return c.html(
    logPanel("/prepare/stream", `Preparing ${asin}...`, queuedSwap(asin)),
  );
});

routes.get("/prepare/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "prepare" || !ownsOperation(op)) {
    return c.text("No active operation", 404);
  }
  return sseStream(c, op.reporter);
});

routes.get("/convert/stream", (c) => {
  const op = getActiveOperation();
  if (!op || op.type !== "convert" || !ownsOperation(op)) {
    return c.text("No active convert operation", 404);
  }
  return sseStream(c, op.reporter);
});

function logPanel(streamUrl: string, label: string, extra: string = ""): string {
  return `
    <div id="op-progress"></div>
    <div id="op-download"></div>
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
