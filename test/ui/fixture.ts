import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Fixture for browser tests: a real server process against a temp data
 * directory, plus a Chromium page. These tests exist to cover behavior that
 * only appears in a browser — htmx swaps, CSP enforcement, delegated event
 * handlers — which the HTML-level route tests cannot see.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Chromium: explicit path in the dev container, otherwise Playwright's own. */
function browserExecutable(): string | undefined {
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

  const browser: Browser = await chromium.launch({
    executablePath: browserExecutable(),
    args: ["--no-sandbox"],
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

/** Seed books straight into the user-less (legacy) database. */
export async function seedBooks(env: NodeJS.ProcessEnv): Promise<void> {
  const prevDb = process.env.DB_PATH;
  const prevUsers = process.env.USERS_DIR;
  process.env.DB_PATH = env.DB_PATH;
  process.env.USERS_DIR = env.USERS_DIR;

  const db = await import("../../src/db.ts");
  db.closeDb();
  db.upsertBook("B0NOTDOWN1", "Ursula K. Le Guin", "A Wizard of Earthsea");
  db.markDownloaded("B0DOWNLOAD", "Neal Stephenson", "Snow Crash", "/x/B0DOWNLOAD.aaxc");
  db.markDownloaded("B0CONVERT1", "Frank Herbert", "Dune", "/x/B0CONVERT1.aaxc");
  db.markConverted("B0CONVERT1", "/x/converted/Dune", 42);
  db.closeDb();

  process.env.DB_PATH = prevDb;
  process.env.USERS_DIR = prevUsers;
}
