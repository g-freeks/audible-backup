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

export const config = {
  activationBytes: env("AUDIBLE_ACTIVATION_BYTES"),
  targetDir: resolvePath(env("AUDIBLE_TARGET_DIR", "~/Music/audible-backup")),
  outputDir: resolvePath(
    env("AUDIBLE_OUTPUT_DIR", "~/Music/audible-backup/converted"),
  ),
  mp3Quality: env("MP3_QUALITY", "4"),
  downloadDelayMs: parseInt(env("DOWNLOAD_DELAY_MS", "2000"), 10),
  convertDelayMs: parseInt(env("CONVERT_DELAY_MS", "1000"), 10),
  libraryMaxBuffer: parseInt(env("LIBRARY_MAX_BUFFER", "10485760"), 10),
  dbPath: resolvePath(env("DB_PATH", "~/Music/audible-backup/audiobooks.db")),
};
