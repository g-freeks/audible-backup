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

  it("references generated modules that exist and parse", () => {
    for (const file of ["python3-audible.json", "node-modules.json"]) {
      assert.match(manifest, new RegExp(`- ${file.replace(/\./g, "\\.")}`));
      assert.ok(readModule(file).name, `${file} is not a module`);
    }
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
      "regenerate with scripts/generate-flatpak-sources.py",
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

describe("generated python sources", () => {
  const module = readModule("python3-audible.json");
  const requirements = fs
    .readFileSync(path.join(FLATPAK, "python-requirements.txt"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));

  it("pins every distribution to PyPI with a checksum", () => {
    assert.ok(module.sources.length > 0);
    for (const source of module.sources) {
      assert.match(source.url, /^https:\/\/files\.pythonhosted\.org\//, source.url);
      assert.match(source.sha256, /^[0-9a-f]{64}$/, `${source.url}: bad sha256`);
    }
  });

  it("installs exactly the pinned requirements", () => {
    const install = module["build-commands"].at(-1) as string;
    assert.match(install, /--no-index/, "the build has no network");
    assert.match(install, /--target=\/app\/lib\/audible-python/);
    for (const requirement of requirements) {
      assert.ok(install.includes(requirement), `${requirement} is not installed`);
    }
  });

  it("puts the install directory on PYTHONPATH", () => {
    // --target installs outside the interpreter's default search path, so
    // without this the helper would import nothing.
    assert.match(manifest, /--env=PYTHONPATH=\/app\/lib\/audible-python/);
  });

  it("covers every architecture for compiled wheels", () => {
    const arches = new Set<string>();
    for (const source of module.sources) {
      for (const arch of source["only-arches"] ?? []) arches.add(arch);
    }
    // Pillow is the only compiled dependency today; if it is pinned for one
    // architecture it must be pinned for both, or that build silently loses it.
    if (arches.size > 0) {
      assert.deepEqual([...arches].sort(), ["aarch64", "x86_64"]);
    }
  });

  it("vendors the build backend rather than trusting the SDK's", () => {
    const [bootstrap] = module["build-commands"] as string[];
    assert.match(bootstrap, /setuptools==/, "setuptools must be pinned");
    assert.match(bootstrap, /--target="\$\{PWD\}\/_buildtools"/, "keep it out of /app");
  });
});
