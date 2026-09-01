import * as fs from "fs";
import * as path from "path";

function loadEnvFile(): void {
  const envPath = path.resolve(import.meta.dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed
      .slice(eqIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function resolvePath(p: string): string {
  return path.resolve(p.replace("~", process.env.HOME || ""));
}

function env(key: string, fallback: string = ""): string {
  return process.env[key] || fallback;
}

/**
 * Desktop mode: one machine-local user, XDG paths, no login. Set by Flatpak
 * itself (FLATPAK_ID), or forced with AUDIBLE_DESKTOP=1 for development.
 */
export function isDesktopMode(): boolean {
  return !!process.env.FLATPAK_ID || process.env.AUDIBLE_DESKTOP === "1";
}

function xdgDataHome(): string {
  return resolvePath(env("XDG_DATA_HOME", "~/.local/share"));
}

/** ~/Music on a typical system; XDG_MUSIC_DIR when the session sets it. */
function xdgMusicDir(): string {
  return resolvePath(env("XDG_MUSIC_DIR", "~/Music"));
}

/** Where a desktop install keeps its data. Explicit env vars still win. */
export const desktopPaths = {
  get dataDir() {
    return path.join(xdgDataHome(), "audible-backup");
  },
  get targetDir() {
    return path.join(this.dataDir, "aax");
  },
  /** Converted audiobooks belong to the user, not the sandbox. */
  get outputDir() {
    return path.join(xdgMusicDir(), "Audiobooks");
  },
  get dbPath() {
    return path.join(this.dataDir, "audiobooks.db");
  },
  get authDir() {
    return path.join(this.dataDir, "audible");
  },
};

function defaultPath(envKey: string, desktop: string, server: string): string {
  const explicit = process.env[envKey];
  if (explicit) return resolvePath(explicit);
  return isDesktopMode() ? desktop : resolvePath(server);
}

export const config = {
  get activationBytes() {
    return env("AUDIBLE_ACTIVATION_BYTES");
  },
  get targetDir() {
    return defaultPath(
      "AUDIBLE_TARGET_DIR",
      desktopPaths.targetDir,
      "~/Music/audible-backup",
    );
  },
  get outputDir() {
    return defaultPath(
      "AUDIBLE_OUTPUT_DIR",
      desktopPaths.outputDir,
      "~/Music/audible-backup/converted",
    );
  },
  get downloadDelayMs() {
    return parseInt(env("DOWNLOAD_DELAY_MS", "2000"), 10);
  },
  get convertDelayMs() {
    return parseInt(env("CONVERT_DELAY_MS", "1000"), 10);
  },
  get libraryMaxBuffer() {
    return parseInt(env("LIBRARY_MAX_BUFFER", "10485760"), 10);
  },
  get dbPath() {
    return defaultPath(
      "DB_PATH",
      desktopPaths.dbPath,
      "~/Music/audible-backup/audiobooks.db",
    );
  },
};
