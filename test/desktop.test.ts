import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Hono } from "hono";
import { routes } from "../src/web/routes.ts";
import { closeDb, markDownloaded } from "../src/db.ts";
import { resetOperationForTest } from "../src/operations.ts";
import { isDesktopMode, desktopPaths } from "../src/config.ts";
import {
  userDirs,
  ensureDesktopUser,
  DESKTOP_USER,
  getUser,
  runWithUser,
} from "../src/users.ts";

/**
 * Desktop mode is what a Flatpak install runs in: one implicit user, XDG
 * paths, no login, and a per-launch token guarding the localhost server.
 */

const TOKEN = "test-desktop-token";
let tmpDir: string;
let app: Hono;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));
  process.env.AUDIBLE_DESKTOP = "1";
  process.env.AUDIBLE_DESKTOP_TOKEN = TOKEN;
  process.env.XDG_DATA_HOME = path.join(tmpDir, "data");
  process.env.XDG_MUSIC_DIR = path.join(tmpDir, "music");
  process.env.USERS_DIR = path.join(tmpDir, "data", "audible-backup", "users");
  delete process.env.DB_PATH;
  delete process.env.AUDIBLE_TARGET_DIR;
  delete process.env.AUDIBLE_OUTPUT_DIR;
  closeDb();
  app = new Hono();
  app.route("/", routes);
});

afterEach(() => {
  resetOperationForTest();
  closeDb();
  delete process.env.AUDIBLE_DESKTOP;
  delete process.env.AUDIBLE_DESKTOP_TOKEN;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_MUSIC_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const withToken = { headers: { cookie: `desktop_token=${TOKEN}` } };

describe("desktop mode detection", () => {
  it("is on for Flatpak and for the development override", () => {
    assert.equal(isDesktopMode(), true);
    delete process.env.AUDIBLE_DESKTOP;
    assert.equal(isDesktopMode(), false);
    process.env.FLATPAK_ID = "io.github.g_freeks.audible_backup";
    assert.equal(isDesktopMode(), true);
    delete process.env.FLATPAK_ID;
    process.env.AUDIBLE_DESKTOP = "1";
  });
});

describe("XDG paths", () => {
  it("keeps app data under XDG_DATA_HOME", () => {
    assert.equal(desktopPaths.dataDir, path.join(tmpDir, "data", "audible-backup"));
    assert.equal(desktopPaths.targetDir, path.join(tmpDir, "data", "audible-backup", "aax"));
    assert.equal(desktopPaths.dbPath, path.join(tmpDir, "data", "audible-backup", "audiobooks.db"));
  });

  it("puts converted audiobooks in the user's music directory", () => {
    assert.equal(desktopPaths.outputDir, path.join(tmpDir, "music", "Audiobooks"));
  });

  it("resolves the single user's directories to those same paths", () => {
    const dirs = userDirs(DESKTOP_USER);
    assert.equal(dirs.targetDir, desktopPaths.targetDir);
    assert.equal(dirs.outputDir, desktopPaths.outputDir);
    assert.equal(dirs.dbPath, desktopPaths.dbPath);
  });

  it("still lets explicit environment variables win", async () => {
    process.env.AUDIBLE_OUTPUT_DIR = "/tmp/explicit-output";
    // config is computed at import time, so re-import with a fresh specifier.
    const fresh = await import("../src/config.ts?override-check");
    assert.equal(fresh.config.outputDir, "/tmp/explicit-output");
    delete process.env.AUDIBLE_OUTPUT_DIR;
  });
});

describe("implicit desktop user", () => {
  it("is created with its directories on first use", () => {
    assert.equal(getUser(DESKTOP_USER), undefined);
    ensureDesktopUser();
    assert.ok(getUser(DESKTOP_USER), "user registered");
    for (const dir of [desktopPaths.targetDir, desktopPaths.outputDir, desktopPaths.authDir]) {
      assert.ok(fs.existsSync(dir), `${dir} created`);
    }
  });
});

describe("localhost token gate", () => {
  it("refuses requests without the token", async () => {
    assert.equal((await app.request("/")).status, 403);
    assert.equal((await app.request("/api/books")).status, 403);
  });

  it("refuses a wrong token", async () => {
    assert.equal((await app.request("/?token=nope")).status, 403);
  });

  it("accepts the token in the URL and hands back a cookie", async () => {
    const res = await app.request(`/?token=${TOKEN}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    const cookie = res.headers.get("set-cookie") || "";
    assert.match(cookie, new RegExp(`desktop_token=${TOKEN}`));
    assert.match(cookie, /HttpOnly/);
  });

  it("accepts the cookie on subsequent requests", async () => {
    assert.equal((await app.request("/", withToken)).status, 200);
  });
});

describe("single-user desktop UI", () => {
  it("serves the library without any login", async () => {
    // Seed through the same implicit user the request will run as, so both
    // resolve to the XDG database rather than two different files.
    ensureDesktopUser();
    runWithUser(DESKTOP_USER, () =>
      markDownloaded("B0DESKTOP1", "Author", "Desktop Book", "/x.aaxc"),
    );
    const shell = await app.request("/", withToken);
    assert.equal(shell.status, 200);

    const books = await (await app.request("/api/books", withToken)).json();
    assert.ok(books.some((b: { title: string }) => b.title === "Desktop Book"));
  });

  // Account controls (topbar, user switcher) are client-rendered now
  // (Topbar.tsx branches on session.desktop) — the state behind them is
  // already covered by "has no JSON account management endpoints, but
  // keeps GET /api/session" below.

  it("has no account management routes", async () => {
    for (const p of ["/login", "/user/add", "/user/switch", "/user/logout"]) {
      const res = await app.request(p, { method: p === "/login" ? "GET" : "POST", ...withToken });
      assert.equal(res.status, 404, `${p} should not exist in desktop mode`);
    }
  });

  it("has no JSON account management endpoints, but keeps GET /api/session", async () => {
    for (const req of [
      { path: "/api/session", method: "POST" },
      { path: "/api/session", method: "DELETE" },
      { path: "/api/users", method: "POST" },
    ]) {
      const res = await app.request(req.path, { method: req.method, ...withToken });
      assert.equal(res.status, 404, `${req.method} ${req.path} should not exist in desktop mode`);
    }

    const session = await app.request("/api/session", withToken);
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { desktop: true, current: null, others: [] });
  });

  it("shows which build is running", async () => {
    // A packaged install gives no other way to tell whether an update
    // actually landed, which is the whole reason this line exists.
    const settings = await (await app.request("/api/settings", withToken)).json();
    assert.match(settings.version, /[\d.]+ · /, "version and build are shown");
  });

  it("reaches settings without a session, with the account fields desktop mode hides", async () => {
    const res = await app.request("/api/settings", withToken);
    assert.equal(res.status, 200);
    const settings = await res.json();
    assert.equal(settings.audible.available, true, "Audible setup is still offered");
    assert.equal(settings.desktop, true, "no password field or user-name heading — Settings.tsx branches on this");
  });
});

describe("output directory sandbox safety", () => {
  // A path outside --filesystem=xdg-music:create doesn't error in the real
  // Flatpak — it silently resolves against the app's own isolated $HOME
  // (~/.var/app/<id> on the host), so a typed path has to prove it's either
  // under the music dir or came back from the native folder picker.

  it("rejects a hand-typed path outside ~/Music", async () => {
    const outside = path.join(tmpDir, "outside-music", "Audiobooks");
    const res = await app.request("/api/settings", {
      method: "PATCH",
      ...withToken,
      headers: { ...withToken.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: outside }),
    });
    assert.equal(res.status, 400);
    assert.ok(!fs.existsSync(outside), "never created");
  });

  it("accepts the same path once it's marked as coming from the native picker", async () => {
    const outside = path.join(tmpDir, "outside-music", "Audiobooks");
    const res = await app.request("/api/settings", {
      method: "PATCH",
      ...withToken,
      headers: { ...withToken.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: outside, outputDirFromPicker: true }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.outputDir, outside);
    assert.ok(fs.existsSync(outside));
  });

  it("accepts a hand-typed path under ~/Music without needing the picker", async () => {
    const res = await app.request("/api/settings", {
      method: "PATCH",
      ...withToken,
      headers: { ...withToken.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: path.join(tmpDir, "music", "Podcasts") }),
    });
    assert.equal(res.status, 200);
  });

  it("lets an unchanged custom path resave even without the picker flag", async () => {
    const outside = path.join(tmpDir, "outside-music", "Audiobooks");
    await app.request("/api/settings", {
      method: "PATCH",
      ...withToken,
      headers: { ...withToken.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: outside, outputDirFromPicker: true }),
    });

    // Resaving some other field re-sends the same outputDir, unflagged.
    const res = await app.request("/api/settings", {
      method: "PATCH",
      ...withToken,
      headers: { ...withToken.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: outside, audioFormat: "flac", audioQuality: "high" }),
    });
    assert.equal(res.status, 200);
  });

  it("flags an already-saved out-of-sandbox path as at risk", async () => {
    ensureDesktopUser();
    const { setOutputDir } = await import("../src/users.ts");
    setOutputDir(DESKTOP_USER, path.join(tmpDir, "outside-music", "Audiobooks"));

    const settings = await (await app.request("/api/settings", withToken)).json();
    assert.equal(settings.outputDirSandboxRisk, true);
  });

  it("reports no risk for the default output directory", async () => {
    const settings = await (await app.request("/api/settings", withToken)).json();
    assert.equal(settings.outputDirSandboxRisk, false);
  });
});

describe("finished audiobooks on the desktop", () => {
  // The Open Folder button (vs. a ZIP download link) is client-rendered
  // now (Topbar.tsx branches on session.desktop) — POST /open-output itself
  // is covered by "creates the output folder and asks the desktop to open
  // it" below.

  it("creates the output folder and asks the desktop to open it", async () => {
    ensureDesktopUser();
    fs.rmSync(desktopPaths.outputDir, { recursive: true, force: true });

    // Inside Flatpak xdg-open is the portal shim; CI has none at all, so a
    // stub stands in for it and PATH decides which branch runs.
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const realPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const res = await app.request("/open-output", { method: "POST", ...withToken });
      assert.equal(res.status, 204, "reports success when the desktop can open it");
      assert.ok(fs.existsSync(desktopPaths.outputDir), "output folder exists");
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("says so when there is nothing to open the folder with", async () => {
    ensureDesktopUser();
    const realPath = process.env.PATH;
    process.env.PATH = path.join(tmpDir, "empty");
    try {
      const res = await app.request("/open-output", { method: "POST", ...withToken });
      // Reporting 204 here is what made the button look broken rather than
      // unavailable: nothing opens, and nothing says why.
      assert.equal(res.status, 500);
    } finally {
      process.env.PATH = realPath;
    }
  });
});
