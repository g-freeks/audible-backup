import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

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
 * the build reads as "dev" — in that case the settings page instead shows
 * which git ref is checked out, since that is the thing a developer actually
 * wants to confirm. `main` is not shown: it is the assumed default, so
 * calling it out would just be noise.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

export interface BuildInfo {
  /** From package.json. */
  version: string;
  /** UTC timestamp of the packaged build, or "dev" from a source checkout. */
  build: string;
  /** The commit it was built from, when the packager knew it. */
  commit?: string;
  /** Dev builds only: branch name (or short commit if detached), unless it's "main". */
  devRef?: string;
}

/**
 * Picks what to show for a source checkout: the branch name, unless it's
 * "main" (the assumed default, not worth calling out), or the short commit
 * when HEAD is detached. Exported for direct, environment-independent testing.
 */
export function formatDevRef(branch: string, shortCommit: string): string | undefined {
  if (branch && branch !== "HEAD") {
    return branch === "main" ? undefined : branch;
  }
  return shortCommit || undefined;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString().trim();
}

function currentGitRef(): string | undefined {
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const shortCommit = branch === "HEAD" ? git(["rev-parse", "--short", "HEAD"]) : "";
    return formatDevRef(branch, shortCommit);
  } catch {
    // Not a git checkout (e.g. extracted from a source tarball).
    return undefined;
  }
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

  const devRef = build === "dev" ? currentGitRef() : undefined;

  return { version, build, commit, devRef };
}

/** One line for the UI: "1.2.0 · built 2026-09-01T08:15:00Z (2d7e3c7)". */
export function versionLine(): string {
  const info = buildInfo();
  const built = info.build === "dev" ? "development build" : `built ${info.build}`;
  const ref = info.build === "dev" ? info.devRef : info.commit?.slice(0, 7);
  return ref
    ? `${info.version} · ${built} (${ref})`
    : `${info.version} · ${built}`;
}
