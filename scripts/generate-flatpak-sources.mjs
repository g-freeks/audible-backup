/**
 * Generates the offline npm sources the Flatpak build needs.
 *
 *   node scripts/generate-flatpak-sources.mjs
 *
 * Flathub builds have no network access, so every dependency must be declared
 * up front as a URL with a checksum. package-lock.json already carries both,
 * so this needs no network of its own and cannot disagree with what `npm ci`
 * would install.
 *
 * The result is committed; test/flatpak.test.ts fails if it falls behind the
 * lockfile. This used to also vendor a Python dependency tree — that went away
 * when the Audible client moved to TypeScript.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "flatpak", "node-modules.json");

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

const sources = Object.entries(lock.packages)
  .filter(([name, entry]) => name.startsWith("node_modules/") && !entry.dev)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, entry]) => {
    const [algorithm, encoded] = String(entry.integrity || "").split("-", 2);
    if (algorithm !== "sha512" && algorithm !== "sha256") {
      throw new Error(`${name}: unsupported integrity ${entry.integrity}`);
    }
    return {
      type: "archive",
      url: entry.resolved,
      // npm records the hash base64-encoded; flatpak wants it in hex.
      [algorithm]: Buffer.from(encoded, "base64").toString("hex"),
      dest: name,
      // npm tarballs all wrap their contents in a "package/" directory.
      "strip-components": 1,
    };
  });

if (sources.length === 0) {
  throw new Error("no production dependencies found in package-lock.json");
}

const module = {
  name: "node-modules",
  buildsystem: "simple",
  // Unpacked straight into place; there is nothing to compile.
  "build-commands": [
    "mkdir -p /app/share/audible-backup",
    "cp -r node_modules /app/share/audible-backup/node_modules",
  ],
  sources,
};

fs.writeFileSync(OUT, `${JSON.stringify(module, null, 2)}\n`);
for (const source of sources) console.log(`  ${source.dest}`);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
