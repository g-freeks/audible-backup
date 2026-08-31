/**
 * Captures the screenshots referenced by the AppStream metainfo:
 *
 *   node scripts/capture-screenshots.mjs
 *
 * They are shot against a real server in desktop mode — the same shape a
 * Flatpak user sees — with a throwaway library, so the store listing can never
 * drift from what the app actually looks like. The PNGs are committed, so this
 * is a maintainer step rather than part of the build.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "desktop/screenshots");
const TOKEN = "screenshot-session-token";
const PORT = 3399;
// Flathub wants screenshots between 4:3 and 2:1; this keeps both inside it.
const VIEWPORT = { width: 1152, height: 768 };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audible-shots-"));
const env = {
  ...process.env,
  AUDIBLE_DESKTOP: "1",
  AUDIBLE_DESKTOP_TOKEN: TOKEN,
  XDG_DATA_HOME: path.join(dataDir, "data"),
  XDG_MUSIC_DIR: path.join(dataDir, "music"),
  WEB_HOST: "127.0.0.1",
  WEB_PORT: String(PORT),
  WEB_USER: "",
  WEB_PASSWORD: "",
};

/** A library with one book in each state the table can show. */
async function seed() {
  Object.assign(process.env, {
    AUDIBLE_DESKTOP: env.AUDIBLE_DESKTOP,
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    XDG_MUSIC_DIR: env.XDG_MUSIC_DIR,
  });
  const converted = path.join(env.XDG_MUSIC_DIR, "Audiobooks", "Dune");
  fs.mkdirSync(converted, { recursive: true });

  const db = await import("../src/db.ts");
  db.closeDb();
  db.markDownloaded("B0CONVERT1", "Frank Herbert", "Dune", "/x/B0CONVERT1.aaxc");
  db.markConverted("B0CONVERT1", converted, 22);
  db.markDownloaded("B0DOWNLOAD", "Neal Stephenson", "Snow Crash", "/x/B0DOWNLOAD.aaxc");
  db.markDownloaded("B0DOWNLOA2", "Ann Leckie", "Ancillary Justice", "/x/B0DOWNLOA2.aaxc");
  db.upsertBook("B0NOTDOWN1", "Ursula K. Le Guin", "A Wizard of Earthsea");
  db.upsertBook("B0NOTDOWN2", "Becky Chambers", "A Psalm for the Wild-Built");
  db.upsertBook("B0NOTDOWN3", "Martha Wells", "All Systems Red");
  db.closeDb();
}

function browserExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return fs.existsSync("/opt/pw-browsers/chromium")
    ? "/opt/pw-browsers/chromium"
    : undefined;
}

async function waitForServer(url, timeoutMs = 20000) {
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
  throw new Error("server did not start");
}

await seed();

const server = spawn(process.execPath, [path.join(ROOT, "server.ts")], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: browserExecutable() });

try {
  await waitForServer(`${base}/?token=${TOKEN}`);
  fs.mkdirSync(OUT, { recursive: true });

  const page = await browser.newPage({ viewport: VIEWPORT });
  // The token arrives in the URL once and is kept as a cookie afterwards.
  await page.goto(`${base}/?token=${TOKEN}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(OUT, "library.png") });
  console.log("wrote desktop/screenshots/library.png");

  await page.goto(`${base}/user/settings`, { waitUntil: "networkidle" });
  // Stop above the destructive "reset database" card: a store listing should
  // not lead with a half-cropped red warning.
  const dangerTop = await page
    .locator(".danger-zone")
    .evaluate((el) => el.getBoundingClientRect().top);
  await page.screenshot({
    path: path.join(OUT, "settings.png"),
    clip: {
      x: 0,
      y: 0,
      width: VIEWPORT.width,
      // Never narrower than 2:1, whatever the page layout does.
      height: Math.max(Math.round(dangerTop - 24), Math.ceil(VIEWPORT.width / 2)),
    },
  });
  console.log("wrote desktop/screenshots/settings.png");

  await page.close();
} catch (err) {
  console.error(log);
  throw err;
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
