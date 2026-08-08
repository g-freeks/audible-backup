# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Audible Backup Tool syncs an Audible library, downloads AAX audiobook files via `audible-cli`, and converts them to chapter-split MP3s using `ffmpeg`. It has both a CLI (`app.ts`) and a web UI (`server.ts`).

## Commands

All commands require Node 24+ (native type stripping and `node:sqlite`, no flags needed).

```bash
# Run tests (Node built-in test runner)
npm test

# Run a single test file
node --test test/converter.test.ts

# Start the web server (Hono on port 3000)
npm run server

# CLI commands
npm run sync          # Download new audiobooks
npm run convert       # Convert AAX to chapter-split MP3s
npm run sync-convert  # Both in sequence
npm run status        # Show library status
npm run list          # List books ready for conversion
npm run db-status     # Show database contents
npm run db-reset      # Reset the database
```

## Architecture

**Runtime**: Pure TypeScript executed directly by Node 24 via native type stripping (no build step). Uses Node's built-in `node:sqlite` (WAL mode) for persistence.

**Core modules** (`src/`):
- `config.ts` — Loads `.env` manually (no dotenv dependency), exports a `config` object. Environment variables override `.env` values.
- `users.ts` — Multi-tenant user registry (`users.json` under `USERS_DIR`). Each user has an isolated data directory (`aax/`, `converted/`, `audible/`, `audiobooks.db`), optional scrypt-hashed password, and optional per-user activation bytes. The current user travels through async call chains via `AsyncLocalStorage` (`runWithUser`/`currentUser`), which is how `db.ts` and the audible-cli wrappers resolve per-user paths without explicit parameters. With zero registered users the app runs in legacy single-user mode driven by env config.
- `db.ts` — SQLite database with a single `audiobooks` table tracking download/conversion state by ASIN. Keeps one lazy connection per database file; the path resolves to the current user's DB in multi-tenant mode, else `DB_PATH`/config.
- `pyhelper.ts` — Spawns `helper/audible_helper.py` (JSON-over-stdout bridge to the `audible` Python package) for structured library listings and AAXC downloads with decryption vouchers. Throws `HelperUnavailableError` when python3/the package is missing so callers can fall back to audible-cli.
- `library.ts` — `AudibleLibrary` lists and downloads books: helper-first (AAXC + voucher + chapters + cover), falling back to `audible-cli` (AAX) when the helper is unavailable. Auto-imports existing `.aax`/`.aaxc` files into the DB on construction.
- `converter.ts` — `Converter` class uses `ffmpeg` to decrypt AAX→MP3 (activation bytes) or AAXC→MP3 (voucher key/iv via `-audible_key`/`-audible_iv`), then splits by chapters using JSON chapter metadata. Activation bytes are only required for `.aax` inputs, checked per book at convert time.
- `progress.ts` — `ProgressReporter` interface with two implementations: `consoleReporter` (for CLI) and `EventReporter` (EventEmitter for web SSE streaming).
- `operations.ts` — Global singleton tracking the currently active operation (sync or convert), ensuring only one runs at a time.

**Web layer** (`src/web/`):
- `routes.ts` — Hono routes serving HTML pages and a JSON API (`/api/status`, `/api/books`). A session middleware resolves the current user from a cookie (in-memory sessions in `sessions.ts`) and wraps handlers in `runWithUser`; `/login`, `/user/switch`, and `/user/add` are public. POST endpoints for sync/convert return HTMX fragments that connect to SSE streams (streams are only visible to the operation's owner). GET `/download/converted/:asin` streams a converted book as a ZIP; GET `/download/aax/:asin` streams the original AAX file. All ASIN params are validated against `^[A-Z0-9]{10}$`.
- `zip.ts` — Dependency-free store-only streaming ZIP writer (no zip64; 4 GB cap) used for browser downloads.
- `sse.ts` — Bridges `EventReporter` events to SSE responses for real-time log streaming to the browser.
- `templates/` — Server-rendered HTML templates. `html.ts` provides an auto-escaping `html` tagged template (`raw()` for trusted fragments); `components.ts` holds shared badge/progress fragments used by pages, SSE events, and OOB swaps. Templates contain no inline JS — all client behavior lives in `static/app.js` (delegated listeners, so it survives HTMX swaps), which enables the strict CSP set in `routes.ts` via `secureHeaders`.
- `server.ts` (repo root) — Enables HTTP basic auth when `WEB_USER` and `WEB_PASSWORD` are both set.

**Key patterns**:
- `AudibleLibrary` and `Converter` both accept a `ProgressReporter` via constructor injection — `consoleReporter` for CLI use, `EventReporter` for web use.
- Only one long-running operation (sync or convert) can run at a time, enforced by `operations.ts`.
- External tool dependencies: `audible-cli` (Python, for downloading) and `ffmpeg` (for conversion).

## Configuration

All config is in `.env` (see `.env.example`). Key variables: `AUDIBLE_ACTIVATION_BYTES`, `AUDIBLE_TARGET_DIR`, `AUDIBLE_OUTPUT_DIR`, `DB_PATH`, `MP3_QUALITY`.

## Docker

The intended deployment is fully sandboxed: `docker-compose.yml` uses a single **named Docker volume** (`users`, mounted at `/data/users`) — no host bind mounts. Each user's data lives under `/data/users/<name>`. The container runs the web server, and users retrieve their books through the web UI's download endpoints rather than from the host filesystem. Audible login per user: `docker compose exec -e AUDIBLE_CONFIG_DIR=/data/users/<name>/audible audible-backup audible quickstart`.
