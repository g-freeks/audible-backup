import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Hono } from "hono";
import { routes } from "../src/web/routes.ts";
import { closeDb, markDownloaded } from "../src/db.ts";
import { clearOperation } from "../src/operations.ts";
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
  clearOperation();
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
    const html = await (await app.request("/", withToken)).text();
    assert.match(html, /Desktop Book/);
  });

  it("shows Settings but no account controls", async () => {
    const html = await (await app.request("/", withToken)).text();
    assert.match(html, /href="\/user\/settings"/);
    assert.ok(!html.includes("Sign in / Add user"), "no sign-in prompt");
    assert.ok(!html.includes("Sign out"), "no sign-out");
    // topbar-actions holds the user switcher when there is one; topbar-center
    // (search/Columns/etc.) legitimately has its own dropdowns.
    const actions = html.match(/<div class="topbar-actions">[\s\S]*?<\/div>\s*<\/header>/)?.[0] || "";
    assert.ok(!actions.includes("data-dropdown-toggle"), "no user switcher in the topbar");
    assert.match(html, /id="log-toggle"/, "log button is still there");
  });

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
    const html = await (await app.request("/user/settings", withToken)).text();
    assert.match(html, /Audible Backup [\d.]+ · /, "version and build are shown");
  });

  it("reaches settings without a session and hides the password field", async () => {
    const res = await app.request("/user/settings", withToken);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Connect Audible|Audible account/, "Audible setup is still offered");
    assert.match(html, /Reset database/);
    assert.ok(!/name="password"/.test(html), "no password field without accounts");
    assert.ok(!/Settings — /.test(html), "no user name in the heading");
  });
});

describe("finished audiobooks on the desktop", () => {
  it("offers to open the output folder instead of a ZIP download", async () => {
    const html = await (await app.request("/", withToken)).text();
    assert.match(html, /hx-post="\/open-output"/, "Open folder button is present");
  });

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
