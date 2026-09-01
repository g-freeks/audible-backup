import { spawn, type ChildProcess } from "node:child_process";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Fixture for browser tests: a real server process against a temp data
 * directory, plus a browser page (Chromium by default, WebKit with
 * BROWSER=webkit — the desktop shell embeds WebKitGTK, so this is what
 * catches engine differences without needing a Linux desktop to run on).
 * These tests exist to cover behavior that only appears in a browser — htmx
 * swaps, CSP enforcement, delegated event handlers — which the HTML-level
 * route tests cannot see.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function browserType(): BrowserType {
  return process.env.BROWSER === "webkit" ? webkit : chromium;
}

/** Explicit path override, or the dev container's known Chromium location. */
function browserExecutable(): string | undefined {
  if (process.env.BROWSER === "webkit") return process.env.WEBKIT_PATH;
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const containerChromium = "/opt/pw-browsers/chromium";
  return fs.existsSync(containerChromium) ? containerChromium : undefined;
}

export interface UiContext {
  baseUrl: string;
  page: Page;
  dataDir: string;
  /** Console errors and CSP violations collected since page load. */
  consoleErrors: string[];
  close(): Promise<void>;
}

async function waitForServer(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

export async function startUi(
  seed?: (env: NodeJS.ProcessEnv) => void | Promise<void>,
): Promise<UiContext> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-test-"));
  const port = 3300 + Math.floor(Math.random() * 1500);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WEB_PORT: String(port),
    DB_PATH: path.join(dataDir, "audiobooks.db"),
    USERS_DIR: path.join(dataDir, "users"),
    AUDIBLE_TARGET_DIR: path.join(dataDir, "aax"),
    AUDIBLE_OUTPUT_DIR: path.join(dataDir, "converted"),
    AUDIBLE_ACTIVATION_BYTES: "deadbeef",
    WEB_USER: "",
    WEB_PASSWORD: "",
  };
  fs.mkdirSync(env.AUDIBLE_TARGET_DIR!, { recursive: true });
  fs.mkdirSync(env.AUDIBLE_OUTPUT_DIR!, { recursive: true });

  if (seed) await seed(env);

  const server: ChildProcess = spawn(
    process.execPath,
    [path.join(ROOT, "server.ts")],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let serverLog = "";
  server.stdout?.on("data", (d) => (serverLog += d));
  server.stderr?.on("data", (d) => (serverLog += d));

  const baseUrl = `http://localhost:${port}`;
  try {
    await waitForServer(baseUrl);
  } catch (err) {
    server.kill();
    throw new Error(`${err}\nServer output:\n${serverLog}`);
  }

  const engine = browserType();
  const browser: Browser = await engine.launch({
    executablePath: browserExecutable(),
    // --no-sandbox is a Chromium-only flag; WebKit rejects unknown args.
    args: engine === chromium ? ["--no-sandbox"] : [],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  return {
    baseUrl,
    page,
    dataDir,
    consoleErrors,
    async close() {
      await browser.close();
      server.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Run a seeding callback against the fixture's (user-less) database. */
async function withFixtureDb(
  env: NodeJS.ProcessEnv,
  fn: (db: typeof import("../../src/db.ts")) => void,
): Promise<void> {
  const prevDb = process.env.DB_PATH;
  const prevUsers = process.env.USERS_DIR;
  process.env.DB_PATH = env.DB_PATH;
  process.env.USERS_DIR = env.USERS_DIR;

  const db = await import("../../src/db.ts");
  db.closeDb();
  fn(db);
  db.closeDb();

  process.env.DB_PATH = prevDb;
  process.env.USERS_DIR = prevUsers;
}

/**
 * A handful of books covering the different row states. The converted one gets
 * real files on disk so the ZIP download endpoint actually serves it.
 */
export async function seedBooks(env: NodeJS.ProcessEnv): Promise<void> {
  const convertedDir = path.join(env.AUDIBLE_OUTPUT_DIR!, "Dune");
  fs.mkdirSync(convertedDir, { recursive: true });
  fs.writeFileSync(path.join(convertedDir, "01 - Chapter One.mp3"), "fake mp3 audio");
  fs.writeFileSync(path.join(convertedDir, "02 - Chapter Two.mp3"), "more fake audio");

  await withFixtureDb(env, (db) => {
    db.upsertBook("B0NOTDOWN1", "Ursula K. Le Guin", "A Wizard of Earthsea");
    db.markDownloaded("B0DOWNLOAD", "Neal Stephenson", "Snow Crash", "/x/B0DOWNLOAD.aaxc");
    db.markDownloaded("B0CONVERT1", "Frank Herbert", "Dune", "/x/B0CONVERT1.aaxc");
    db.markConverted("B0CONVERT1", convertedDir, 2);
  });
}

/** Enough books that the table overflows its scroll container. */
export async function seedManyBooks(env: NodeJS.ProcessEnv): Promise<void> {
  await withFixtureDb(env, (db) => {
    for (let i = 1; i <= 14; i++) {
      const asin = `B0MENU${String(i).padStart(5, "0")}`;
      db.markDownloaded(asin, `Author ${i}`, `Book Number ${i}`, `/x/${asin}.aaxc`);
    }
  });
}

/** One book whose author name is long enough to break a naive table layout. */
export async function seedLongAuthor(env: NodeJS.ProcessEnv): Promise<void> {
  await withFixtureDb(env, (db) => {
    db.markDownloaded(
      "B0LONGAUTH",
      "Wolfgang Amadeus Hieronymus Bartholomew Featherstonehaugh von Habsburg III",
      "The Very Long Author Book",
      "/x/B0LONGAUTH.aaxc",
    );
    db.markDownloaded("B0SHORTAUT", "Iain M. Banks", "Consider Phlebas", "/x/B0SHORTAUT.aaxc");
  });
}
