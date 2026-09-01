import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { buildInfo, versionLine, formatDevRef } from "../src/version.ts";

/**
 * The settings page shows which build is running. That only helps if it is
 * honest: a packaged build must report its stamp, and a source checkout must
 * not pretend to be one.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const STAMP = path.join(ROOT, "build-info.json");

/** Runs `fn` with a stamp file in place, then removes it. */
function withStamp<T>(contents: string, fn: () => T): T {
  const existed = fs.existsSync(STAMP);
  assert.ok(!existed, "a stray build-info.json would make this test lie");
  fs.writeFileSync(STAMP, contents);
  try {
    return fn();
  } finally {
    fs.rmSync(STAMP, { force: true });
  }
}

describe("build information", () => {
  it("reports a source checkout as a development build", () => {
    assert.equal(fs.existsSync(STAMP), false, "the repository ships no stamp");
    assert.equal(buildInfo().build, "dev");
    assert.match(versionLine(), /development build/);
  });

  it("reports the version from package.json", () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ).version;
    assert.equal(buildInfo().version, expected);
    assert.ok(versionLine().startsWith(expected));
  });

  it("reports the stamp a packaged build writes", () => {
    withStamp('{"build":"2026-09-01T09:00:00Z"}', () => {
      assert.equal(buildInfo().build, "2026-09-01T09:00:00Z");
      assert.match(versionLine(), /built 2026-09-01T09:00:00Z/);
    });
  });

  it("names the commit when the packager knew it", () => {
    withStamp('{"build":"2026-09-01T09:00:00Z","commit":"2d7e3c73459348053cab6b2"}', () => {
      assert.match(versionLine(), /\(2d7e3c7\)$/, "shortened for readability");
    });
  });

  it("survives a stamp that is missing, empty or malformed", () => {
    // A broken stamp must not take the settings page down with it.
    for (const contents of ["", "not json", "{}", '{"commit":"abc"}']) {
      withStamp(contents, () => {
        assert.equal(buildInfo().build, "dev");
        assert.ok(versionLine().length > 0);
      });
    }
  });
});

describe("dev ref shown alongside a development build", () => {
  it("suppresses the ref on main — the assumed default is not worth calling out", () => {
    assert.equal(formatDevRef("main", ""), undefined);
  });

  it("shows a non-main branch name", () => {
    assert.equal(formatDevRef("feature-x", ""), "feature-x");
  });

  it("falls back to the short commit when HEAD is detached", () => {
    assert.equal(formatDevRef("HEAD", "b53b774"), "b53b774");
  });

  it("has nothing to show for a detached HEAD with no commit either", () => {
    assert.equal(formatDevRef("HEAD", ""), undefined);
  });

  it("a dev build's devRef, when present, ends up in versionLine()", () => {
    // Runs against the real checkout: whatever git reports for this working
    // tree is exactly what should appear, since main is deliberately omitted.
    const info = buildInfo();
    if (info.build !== "dev") return; // packaged in this environment
    if (info.devRef) {
      assert.ok(versionLine().includes(`(${info.devRef})`));
    } else {
      assert.ok(!/\(.*\)/.test(versionLine()), "main (or no git) shows no ref");
    }
  });
});
