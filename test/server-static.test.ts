import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Regression test for a bug that only appeared once the app was launched by
 * something other than `npm run server`.
 *
 * serveStatic resolves its `root` against the process's working directory, so
 * a relative root only worked when the server happened to be started from the
 * repository root. A desktop launcher starts it from wherever the session
 * began, and every asset 404'd — which does not look like a crash. The shell
 * HTML still rendered; the React bundle it links to just silently failed to
 * load, leaving a blank page.
 *
 * Route-level tests cannot catch this: serveStatic is mounted in server.ts,
 * not in routes.ts, so it takes a real process to see it.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "static-test-token";
const ASSETS = ["app.js", "app.css"];

interface RunningServer {
  origin: string;
  stop(): void;
}

/** Boots the server from `cwd` and returns the origin it is listening on. */
async function startFrom(cwd: string): Promise<RunningServer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-test-"));

  // Desktop mode asks the OS for a free port and prints it, which saves
  // guessing one, and it is the mode a launcher actually uses.
  const server: ChildProcess = spawn(
    process.execPath,
    [path.join(ROOT, "server.ts")],
    {
      cwd,
      env: {
        ...process.env,
        AUDIBLE_DESKTOP: "1",
        AUDIBLE_DESKTOP_TOKEN: TOKEN,
        XDG_DATA_HOME: path.join(tmpDir, "data"),
        XDG_MUSIC_DIR: path.join(tmpDir, "music"),
        WEB_USER: "",
        WEB_PASSWORD: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stop = () => {
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  let output = "";
  server.stdout?.on("data", (d) => (output += d));
  server.stderr?.on("data", (d) => (output += d));

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const match = output.match(/AUDIBLE_BACKUP_URL=(\S+)/);
    if (match) return { origin: match[1].replace(/\/\?token=.*$/, ""), stop };
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  stop();
  throw new Error(`server did not announce a URL:\n${output}`);
}

describe("static assets do not depend on the working directory", () => {
  it("serves its scripts when started from an unrelated directory", async () => {
    // os.tmpdir() stands in for "wherever a desktop session happened to be".
    const server = await startFrom(os.tmpdir());
    const headers = { cookie: `desktop_token=${TOKEN}` };

    try {
      for (const asset of ASSETS) {
        const res = await fetch(`${server.origin}/static/${asset}`, { headers });
        assert.equal(
          res.status,
          200,
          `/static/${asset} must load, or the React client never mounts`,
        );
        assert.ok((await res.text()).length > 0, `/static/${asset} is empty`);
      }

      // The same absolute root must not become a way out of the directory.
      const traversal = await fetch(`${server.origin}/static/../../../etc/passwd`, {
        headers,
        redirect: "manual",
      });
      assert.notEqual(traversal.status, 200, "path traversal must not resolve");
    } finally {
      server.stop();
    }
  });
});
