import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What build is this?
 *
 * A packaged install gives no easy way to tell whether the bundle you just
 * installed is the one actually running — a Flatpak that failed to update
 * looks exactly like one that succeeded. So the build stamps itself, and the
 * settings page shows it.
 *
 * `build-info.json` is written at package time (see the Flatpak manifest and
 * the Dockerfile). Running from a source checkout there is no such file, and
 * the build reads as "dev".
 */

const ROOT = path.resolve(import.meta.dirname, "..");

export interface BuildInfo {
  /** From package.json. */
  version: string;
  /** UTC timestamp of the packaged build, or "dev" from a source checkout. */
  build: string;
  /** The commit it was built from, when the packager knew it. */
  commit?: string;
}

/** Not cached: the settings page renders rarely, and a stale cache would be
 * exactly the wrong thing when the point is checking what is running. */
export function buildInfo(): BuildInfo {
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  } catch {
    // Reading our own package.json should not be able to break the app.
  }

  let build = "dev";
  let commit: string | undefined;
  try {
    const stamp = JSON.parse(
      fs.readFileSync(path.join(ROOT, "build-info.json"), "utf8"),
    );
    if (stamp.build) build = String(stamp.build);
    if (stamp.commit) commit = String(stamp.commit);
  } catch {
    // Not packaged: "dev" is the honest answer.
  }

  return { version, build, commit };
}

/** One line for the UI: "1.2.0 · built 2026-09-01T08:15:00Z (2d7e3c7)". */
export function versionLine(): string {
  const info = buildInfo();
  const built = info.build === "dev" ? "development build" : `built ${info.build}`;
  return info.commit
    ? `${info.version} · ${built} (${info.commit.slice(0, 7)})`
    : `${info.version} · ${built}`;
}
