import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * The Flatpak build is offline: every dependency is a pinned URL with a
 * checksum, generated from this repository's own lockfiles. That generation
 * step is easy to forget — bump a dependency, and the manifest quietly keeps
 * building the old one until a Flathub build fails hours later. These tests
 * are the fast version of that feedback.
 *
 * They do not build anything; flatpak-builder is the only thing that can
 * prove the manifest works, which is what the phase 4 CI job is for.
 */

const APP_ID = "io.github.g_freeks.audible_backup";
const ROOT = path.resolve(import.meta.dirname, "..");
const FLATPAK = path.join(ROOT, "flatpak");

const manifest = fs.readFileSync(
  path.join(FLATPAK, `${APP_ID}.yml`),
  "utf8",
);

function readModule(name: string) {
  return JSON.parse(fs.readFileSync(path.join(FLATPAK, name), "utf8"));
}

/** base64 npm integrity ("sha512-…") as the lowercase hex flatpak wants. */
function integrityToHex(integrity: string): { algorithm: string; hex: string } {
  const [algorithm, encoded] = integrity.split("-", 2);
  return { algorithm, hex: Buffer.from(encoded, "base64").toString("hex") };
}

describe("flatpak manifest", () => {
  it("builds the app this repository actually is", () => {
    assert.match(manifest, new RegExp(`^id: ${APP_ID.replace(/\./g, "\\.")}$`, "m"));
    assert.match(manifest, /^command: audible-backup$/m);
  });

  it("uses a GNOME runtime, which is the only one with WebKitGTK and gjs", () => {
    assert.match(manifest, /^runtime: org\.gnome\.Platform$/m);
    assert.match(manifest, /^sdk: org\.gnome\.Sdk$/m);
    const version = manifest.match(/^runtime-version: '(\d+)'$/m);
    assert.ok(version, "runtime-version must be pinned");
    // GNOME 48 went end-of-life in March 2026.
    assert.ok(Number(version[1]) >= 49, `runtime ${version[1]} is end-of-life`);
  });

  it("asks only for permissions the app can justify", () => {
    const args = [...manifest.matchAll(/^\s+- (--[a-z-]+=?[^\s]*)$/gm)].map((m) => m[1]);
    const required = [
      "--share=network", // Audible's API
      "--socket=wayland",
      "--socket=fallback-x11",
      "--filesystem=xdg-music:create", // where converted books go
    ];
    for (const arg of required) assert.ok(args.includes(arg), `missing ${arg}`);

    // Anything broader than the music directory would defeat the sandbox.
    const filesystems = args.filter((a) => a.startsWith("--filesystem="));
    assert.deepEqual(filesystems, ["--filesystem=xdg-music:create"]);
    assert.ok(!args.includes("--share=home"), "must not request the home directory");
  });

  it("references a generated module that exists and parses", () => {
    assert.match(manifest, /- node-modules\.json/);
    assert.ok(readModule("node-modules.json").name, "node-modules.json is not a module");
  });

  it("installs everything the desktop shell goes looking for", () => {
    // The shell hardcodes these two paths; if the manifest stops producing
    // them the app launches to an error page.
    assert.match(manifest, /install -Dm755 \/usr\/lib\/sdk\/node24\/bin\/node \/app\/bin\/node/);
    assert.match(manifest, /cp -r server\.ts .*\/app\/share\/audible-backup\//);
    assert.match(manifest, /\/app\/bin\/audible-backup/);

    const shell = fs.readFileSync(path.join(ROOT, "desktop/audible-backup"), "utf8");
    for (const expected of ["/app/bin/node", "/app/share/audible-backup/server.ts"]) {
      assert.ok(shell.includes(expected), `shell no longer looks for ${expected}`);
      assert.ok(manifest.includes(expected.replace("/server.ts", "/")),
        `manifest no longer produces ${expected}`);
    }
  });

  it("installs the desktop files under the names they actually have", () => {
    for (const file of [
      `desktop/${APP_ID}.desktop`,
      `desktop/${APP_ID}.metainfo.xml`,
      `desktop/icons/scalable/${APP_ID}.svg`,
      `desktop/icons/128x128/${APP_ID}.png`,
      `desktop/icons/256x256/${APP_ID}.png`,
    ]) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
      assert.ok(manifest.includes(file), `manifest does not install ${file}`);
    }
  });

  it("does not ship the source it deliberately skips", () => {
    // node_modules comes from pinned tarballs, not the working tree.
    const skip = manifest.slice(manifest.indexOf("skip:"));
    for (const dir of ["node_modules", ".git", "test"]) {
      assert.match(skip, new RegExp(`- ${dir.replace(".", "\\.")}$`, "m"));
    }
  });
});

describe("generated npm sources", () => {
  const module = readModule("node-modules.json");
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const production = Object.entries(lock.packages as Record<string, any>).filter(
    ([name, entry]) => name.startsWith("node_modules/") && !entry.dev,
  );

  it("covers exactly the production dependencies in the lockfile", () => {
    assert.deepEqual(
      module.sources.map((s: any) => s.dest).sort(),
      production.map(([name]) => name).sort(),
      "regenerate with scripts/generate-flatpak-sources.mjs",
    );
  });

  it("pins the same tarball and checksum npm would install", () => {
    for (const [name, entry] of production) {
      const source = module.sources.find((s: any) => s.dest === name);
      assert.equal(source.url, entry.resolved, `${name}: stale URL`);

      const { algorithm, hex } = integrityToHex(entry.integrity);
      assert.equal(source[algorithm], hex, `${name}: checksum does not match the lockfile`);
      // npm tarballs wrap everything in package/.
      assert.equal(source["strip-components"], 1);
    }
  });
});

describe("no Python in the build", () => {
  it("declares no Python module and no PYTHONPATH", () => {
    // The Audible client is TypeScript now. A stray PYTHONPATH or a
    // resurrected python module would mean the runtime dependency crept back.
    assert.ok(!manifest.includes("PYTHONPATH"), "no PYTHONPATH is needed");
    assert.ok(!manifest.includes("python3-audible"), "no Python module");
    assert.ok(!fs.existsSync(path.join(FLATPAK, "python3-audible.json")));
    assert.ok(!fs.existsSync(path.join(FLATPAK, "python-requirements.txt")));
  });

  it("does not ship the Python helper", () => {
    // It stays in the repository as an escape hatch for server installs, but
    // without its dependencies it could only fail inside the sandbox.
    const skip = manifest.slice(manifest.indexOf("skip:"));
    assert.match(skip, /- helper$/m);
    assert.ok(!/cp -r [^\n]*\bhelper\b/.test(manifest), "helper is not copied into /app");
  });

  it("checks in the smoke test that Python really is gone", () => {
    const smoke = fs.readFileSync(path.join(FLATPAK, "smoke-test.sh"), "utf8");
    assert.match(smoke, /audible-python/, "the sandbox check must still run");
  });
});

describe("flatpak CI job", () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github/workflows/flatpak.yml"),
    "utf8",
  );

  it("builds the manifest that exists and runs the smoke test", () => {
    assert.match(workflow, /flatpak\/io\.github\.g_freeks\.audible_backup\.yml/);
    assert.match(workflow, /flatpak\/smoke-test\.sh/);
  });

  it("keeps the smoke test executable", () => {
    const script = path.join(FLATPAK, "smoke-test.sh");
    assert.ok(fs.statSync(script).mode & 0o111, "smoke-test.sh must be executable");
    assert.match(fs.readFileSync(script, "utf8"), /^#!\/usr\/bin\/env bash\n/);
  });

  it("rebuilds when anything that lands in the bundle changes", () => {
    // The manifest copies these into /app; if one stopped triggering the job,
    // a broken bundle could reach a release unnoticed. Each has to appear in
    // both the push and the pull_request filter — being listed under only one
    // of them is the easy mistake, and looks fine at a glance.
    for (const pathFilter of ["flatpak/**", "desktop/**", "src/**", "helper/**",
                              "server.ts", "package-lock.json"]) {
      const occurrences = workflow.split(`'${pathFilter}'`).length - 1;
      assert.ok(
        occurrences >= 2,
        `${pathFilter} appears in ${occurrences} trigger(s), expected push and pull_request`,
      );
    }
  });

  it("does not use YAML anchors, which GitHub Actions cannot parse", () => {
    assert.ok(!/^\s*\w+:\s*&\w+/m.test(workflow), "anchor definition found");
    assert.ok(!/:\s*\*\w+\s*$/m.test(workflow), "anchor reference found");
  });

  it("smoke-tests the same app ID the manifest builds", () => {
    const script = fs.readFileSync(path.join(FLATPAK, "smoke-test.sh"), "utf8");
    assert.match(script, new RegExp(`APP=${APP_ID.replace(/\./g, "\\.")}$`, "m"));
  });
});

describe("the Docker image", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

  it("installs no Python and no audible-cli", () => {
    // The Audible client is TypeScript; Python in the image would be ~100 MB
    // of dependency nobody uses. Comments are stripped first so that saying
    // "no Python" in one does not trip the check.
    const directives = dockerfile
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    for (const gone of ["python3", "python3-pip", "python3-venv", "audible-cli", "venv", "pip install"]) {
      assert.ok(!directives.includes(gone), `Dockerfile still installs ${gone}`);
    }
  });

  it("still installs ffmpeg, which conversion genuinely needs", () => {
    assert.match(dockerfile, /apt-get install[^\n]*ffmpeg/);
  });

  it("stamps the build so Settings can report it", () => {
    assert.match(dockerfile, /build-info\.json/);
  });

  it("is built on pull requests, not only after merge", () => {
    // Nothing else covers the Dockerfile — the unit and browser suites never
    // touch it — so without this a broken image reaches main before anyone
    // finds out.
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
    assert.match(ci, /github\.event_name == 'pull_request'/);
    assert.match(ci, /name: Build \(pull request\)/);
    assert.match(ci, /name: Smoke-test the image/);
  });
});
