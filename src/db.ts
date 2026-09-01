import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import { config } from "./config.ts";
import { currentUserName, userDirs } from "./users.ts";

// One connection per database file. In multi-tenant mode each user has their
// own database; the current user is resolved from the async context.
const connections = new Map<string, DatabaseSync>();

function resolveDbPath(): string {
  const userName = currentUserName();
  if (userName) {
    return userDirs(userName).dbPath;
  }
  if (process.env.DB_PATH) {
    return path.resolve(
      process.env.DB_PATH.replace("~", process.env.HOME || ""),
    );
  }
  return config.dbPath;
}

function initSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
        CREATE TABLE IF NOT EXISTS audiobooks (
            asin TEXT PRIMARY KEY,
            author TEXT,
            title TEXT,
            downloaded_at TEXT,
            aax_path TEXT,
            ignored_at TEXT,
            not_downloadable_at TEXT
        )
    `);

  // Migration: add columns if they don't exist
  const cols = db.prepare("PRAGMA table_info(audiobooks)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "ignored_at")) {
    db.exec("ALTER TABLE audiobooks ADD COLUMN ignored_at TEXT");
  }
  if (!cols.some((c) => c.name === "not_downloadable_at")) {
    db.exec("ALTER TABLE audiobooks ADD COLUMN not_downloadable_at TEXT");
  }

  // Migration: the DB used to track the whole download->convert pipeline.
  // Conversion state is now derived from the filesystem instead (see
  // converter.ts's findConvertedChapters), so drop those columns.
  for (const col of ["converted_at", "output_path", "chapter_count"]) {
    if (cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE audiobooks DROP COLUMN ${col}`);
    }
  }
}

export function getDb(): DatabaseSync {
  const dbPath = resolveDbPath();
  const existing = connections.get(dbPath);
  if (existing) return existing;

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  connections.set(dbPath, db);
  return db;
}

export function resetDatabase(): void {
  const db = getDb();
  db.exec("DROP TABLE IF EXISTS audiobooks;");
  initSchema(db);
}

export function closeDb(): void {
  for (const db of connections.values()) {
    db.close();
  }
  connections.clear();
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
            aax_path = excluded.aax_path,
            not_downloadable_at = NULL
    `,
  ).run(asin, author, title, aaxPath);
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

export interface AudiobookRow {
  asin: string;
  author: string | null;
  title: string | null;
  downloaded_at: string | null;
  aax_path: string | null;
  ignored_at: string | null;
  not_downloadable_at: string | null;
}

export function getAllAudiobooks(): AudiobookRow[] {
  const d = getDb();
  return d
      .prepare("SELECT * FROM audiobooks WHERE ignored_at IS NULL ORDER BY downloaded_at DESC")
      .all() as unknown as AudiobookRow[];
}

// Downloaded books first (most recently downloaded first), then
// not-yet-downloaded ones alphabetically. Replaces the old status-filter UI
// with a single default sort by last-downloaded.
export function getAllBooks(): AudiobookRow[] {
  const d = getDb();
  return d
      .prepare(
        "SELECT * FROM audiobooks ORDER BY (downloaded_at IS NULL) ASC, downloaded_at DESC, title ASC",
      )
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

export function markNotDownloadable(asin: string): void {
  const d = getDb();
  d.prepare(`
    UPDATE audiobooks SET not_downloadable_at = datetime('now') WHERE asin = ?
  `).run(asin);
}

export function upsertBook(asin: string, author: string, title: string): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO audiobooks (asin, author, title)
    VALUES (?, ?, ?)
    ON CONFLICT(asin) DO UPDATE SET author = excluded.author, title = excluded.title
  `).run(asin, author, title);
}

export function getNotDownloadedBooks(): AudiobookRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM audiobooks WHERE downloaded_at IS NULL AND ignored_at IS NULL AND not_downloadable_at IS NULL ORDER BY title")
    .all() as unknown as AudiobookRow[];
}

export function deleteBook(asin: string): void {
  const d = getDb();
  d.prepare(`
    UPDATE audiobooks SET
      downloaded_at = NULL,
      aax_path = NULL,
      not_downloadable_at = NULL
    WHERE asin = ?
  `).run(asin);
}

export function getAudiobookByAsin(asin: string): AudiobookRow | undefined {
  const d = getDb();
  return d
    .prepare("SELECT * FROM audiobooks WHERE asin = ?")
    .get(asin) as unknown as AudiobookRow | undefined;
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
