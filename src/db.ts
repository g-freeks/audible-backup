import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import { config } from "./config.ts";

let db: DatabaseSync | null = null;

function resolveDbPath(): string {
  if (process.env.DB_PATH) {
    return path.resolve(
      process.env.DB_PATH.replace("~", process.env.HOME || ""),
    );
  }
  return config.dbPath;
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const dbPath = resolveDbPath();
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
        CREATE TABLE IF NOT EXISTS audiobooks (
            asin TEXT PRIMARY KEY,
            author TEXT,
            title TEXT,
            downloaded_at TEXT,
            converted_at TEXT,
            aax_path TEXT,
            output_path TEXT,
            chapter_count INTEGER,
            ignored_at TEXT
        )
    `);

  // Migration: add ignored_at column if it doesn't exist
  const cols = db.prepare("PRAGMA table_info(audiobooks)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "ignored_at")) {
    db.exec("ALTER TABLE audiobooks ADD COLUMN ignored_at TEXT");
  }

  return db;
}

export function resetDatabase(): void {
  const db = getDb()
  db.exec("DROP TABLE IF EXISTS audiobooks;");
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function markDownloaded(
  asin: string,
  author: string,
  title: string,
  aaxPath: string,
): void {
  const d = getDb();
  d.prepare(
    `
        INSERT INTO audiobooks (asin, author, title, downloaded_at, aax_path)
        VALUES (?, ?, ?, datetime('now'), ?)
        ON CONFLICT(asin) DO UPDATE SET
            author = excluded.author,
            title = excluded.title,
            downloaded_at = excluded.downloaded_at,
            aax_path = excluded.aax_path
    `,
  ).run(asin, author, title, aaxPath);
}

export function markConverted(
  asin: string,
  outputPath: string,
  chapterCount: number,
): void {
  const d = getDb();
  d.prepare(
    `
        UPDATE audiobooks SET
            converted_at = datetime('now'),
            output_path = ?,
            chapter_count = ?
        WHERE asin = ?
    `,
  ).run(outputPath, chapterCount, asin);
}

export function isDownloaded(asin: string): boolean {
  const d = getDb();
  const row = d
    .prepare(
      "SELECT 1 FROM audiobooks WHERE asin = ? AND downloaded_at IS NOT NULL",
    )
    .get(asin) as Record<string, unknown> | undefined;
  return row !== undefined;
}

export function isConverted(asin: string): boolean {
  const d = getDb();
  const row = d
    .prepare(
      "SELECT 1 FROM audiobooks WHERE asin = ? AND converted_at IS NOT NULL",
    )
    .get(asin) as Record<string, unknown> | undefined;
  return row !== undefined;
}

export interface AudiobookRow {
  asin: string;
  author: string | null;
  title: string | null;
  downloaded_at: string | null;
  converted_at: string | null;
  aax_path: string | null;
  output_path: string | null;
  chapter_count: number | null;
  ignored_at: string | null;
}

export function getAllAudiobooks(): AudiobookRow[] {
  const d = getDb();
  return d
      .prepare("SELECT * FROM audiobooks WHERE ignored_at IS NULL ORDER BY downloaded_at DESC")
      .all() as unknown as AudiobookRow[];
}

export function getAllIgnoredBooks(): AudiobookRow[] {
  const d = getDb();
  return d
      .prepare("SELECT * FROM audiobooks WHERE ignored_at IS NOT NULL ORDER BY ignored_at DESC")
      .all() as unknown as AudiobookRow[];
}

export function getDownloadedAsins(): Set<string> {
  const d = getDb();
  const rows = d
    .prepare("SELECT asin FROM audiobooks WHERE downloaded_at IS NOT NULL AND ignored_at IS NULL")
    .all() as { asin: string }[];
  return new Set(rows.map((r) => r.asin));
}

export function getConvertedAsins(): Set<string> {
  const d = getDb();
  const rows = d
    .prepare("SELECT asin FROM audiobooks WHERE converted_at IS NOT NULL AND ignored_at IS NULL")
    .all() as { asin: string }[];
  return new Set(rows.map((r) => r.asin));
}

export function ignoreBook(asin: string): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO audiobooks (asin, ignored_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(asin) DO UPDATE SET ignored_at = datetime('now')
  `).run(asin);
}

export function unignoreBook(asin: string): void {
  const d = getDb();
  d.prepare("UPDATE audiobooks SET ignored_at = NULL WHERE asin = ?").run(asin);
}

export function isIgnored(asin: string): boolean {
  const d = getDb();
  const row = d
    .prepare("SELECT 1 FROM audiobooks WHERE asin = ? AND ignored_at IS NOT NULL")
    .get(asin) as Record<string, unknown> | undefined;
  return row !== undefined;
}

export function getIgnoredAsins(): Set<string> {
  const d = getDb();
  const rows = d
    .prepare("SELECT asin FROM audiobooks WHERE ignored_at IS NOT NULL")
    .all() as { asin: string }[];
  return new Set(rows.map((r) => r.asin));
}

export function importExistingDownloads(asins: Map<string, string>): number {
  const d = getDb();
  const stmt = d.prepare(`
        INSERT INTO audiobooks (asin, downloaded_at, aax_path)
        VALUES (?, datetime('now'), ?)
        ON CONFLICT(asin) DO NOTHING
    `);
  let imported = 0;
  for (const [asin, aaxPath] of asins) {
    const result = stmt.run(asin, aaxPath);
    if (result.changes > 0) imported++;
  }
  return imported;
}
