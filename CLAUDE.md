# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Audible Backup Tool syncs an Audible library, downloads AAX audiobook files via `audible-cli`, and converts them to chapter-split MP3s using `ffmpeg`. It has both a CLI (`app.ts`) and a web UI (`server.ts`).

## Commands

All commands require Node 24+ (native type stripping and `node:sqlite`, no flags needed).

```bash
# Run unit/route tests (Node built-in test runner)
npm test

# Run browser tests (Chromium via playwright-core; starts a real server)
npm run test:ui

# Everything
npm run test:all

# Run a single test file
node --test test/converter.test.ts

# Start the web server (Hono on port 3000)
npm run server

# Rebuild the React client after editing src/web/client/ — commit the output
npm run build:client
npm run build:client:watch  # rebuild on change during development

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

**Runtime**: The server and CLI are pure TypeScript executed directly by Node 24 via native type stripping (no build step). Uses Node's built-in `node:sqlite` (WAL mode) for persistence. The one exception is the web client (below), which is a React app built by esbuild into a committed static bundle — Flathub builds have no network and skip devDependencies when vendoring, so the bundle has to already exist in git; there is nothing for the Flatpak build itself to compile.

**Core modules** (`src/`):
- `config.ts` — Loads `.env` manually (no dotenv dependency), exports a `config` object. Environment variables override `.env` values.
- `config.ts` also exposes **desktop mode** (`isDesktopMode()`, `desktopPaths`), enabled by `FLATPAK_ID` or `AUDIBLE_DESKTOP=1`. It switches the app to a single implicit user (`DESKTOP_USER`) with XDG paths — data under `$XDG_DATA_HOME/audible-backup`, converted books in `$XDG_MUSIC_DIR/Audiobooks` — binds the server to `127.0.0.1` on an OS-assigned port, prints `AUDIBLE_BACKUP_URL=` for a launcher to read, and guards every request with a per-launch token (`src/web/desktop.ts`). Account routes 404 and the account UI is hidden. Explicit env vars still override paths in every mode. See `docs/flatpak-plan.md`.
- **Desktop shell** (`desktop/`) — a GJS + GTK4 + libadwaita + WebKitGTK
  launcher (`desktop/audible-backup`) that spawns `server.ts`, waits for its
  `AUDIBLE_BACKUP_URL=` line, and shows it in an `Adw.ApplicationWindow`; plus
  the `.desktop` entry, AppStream metainfo, icons and store screenshots. The
  page renders its own dark theme unconditionally, so the shell forces the
  window chrome dark too (`Adw.StyleManager`) rather than clashing with it —
  meant to follow the page once the page follows the system theme instead.
  Icons and screenshots are regenerated with `node scripts/render-icons.mjs`
  and `node scripts/capture-screenshots.mjs` and committed.
  `test/desktop-files.test.ts` checks that the app ID, icon sizes and
  screenshot URLs stay in sync. There is no gjs in the dev container, so the
  shell itself cannot be run here.
- **Flatpak packaging** (`flatpak/`) — the manifest plus a generated module
  file listing every npm dependency as a pinned URL with a checksum (Flathub
  builds have no network). Regenerate with
  `node scripts/generate-flatpak-sources.mjs` and commit the result;
  `test/flatpak.test.ts` fails if it drifts from `package-lock.json`. ffmpeg
  comes from the runtime — no extensions are declared, and no Python ships.
- `users.ts` — Multi-tenant user registry (`users.json` under `USERS_DIR`). Each user has an isolated data directory (`aax/`, `converted/`, `audible/`, `audiobooks.db`), optional scrypt-hashed password, and optional per-user activation bytes. The current user travels through async call chains via `AsyncLocalStorage` (`runWithUser`/`currentUser`), which is how `db.ts` and the audible-cli wrappers resolve per-user paths without explicit parameters. With zero registered users the app runs in legacy single-user mode driven by env config.
- `db.ts` — SQLite database with a single `audiobooks` table tracking download/conversion state by ASIN. Keeps one lazy connection per database file; the path resolves to the current user's DB in multi-tenant mode, else `DB_PATH`/config.
- `audible/` — the Audible client, in TypeScript: marketplaces, PKCE sign-in and device registration (`login.ts`), credential storage and ADP request signing (`auth.ts`), the API and licence-voucher decryption (`client.ts`), and the commands the app uses (`commands.ts`). Ported from the `audible` Python package; `test/audible.test.ts` checks it against vectors that package generated (`scripts/generate-audible-vectors.py`).
- `pyhelper.ts` — Dispatches those commands and returns the same JSON events the old Python helper did, so callers did not change. Setting `AUDIBLE_HELPER` still routes to an external process, which is how tests drive a fake helper.
- `library.ts` — `AudibleLibrary` lists and downloads books: helper-first (AAXC + voucher + chapters + cover), falling back to `audible-cli` (AAX) when the helper is unavailable. Auto-imports existing `.aax`/`.aaxc` files into the DB on construction.
- `converter.ts` — `Converter` class uses `ffmpeg` to decrypt AAX→MP3 (activation bytes) or AAXC→MP3 (voucher key/iv via `-audible_key`/`-audible_iv`), then splits by chapters using JSON chapter metadata. Activation bytes are only required for `.aax` inputs, checked per book at convert time.
- `progress.ts` — `ProgressReporter` interface with two implementations: `consoleReporter` (for CLI) and `EventReporter` (EventEmitter for web SSE streaming).
- `operations.ts` — Global singleton tracking the currently active operation (sync or convert), ensuring only one runs at a time.

**Web layer** (`src/web/`):
- `routes.ts` — Hono routes serving one SPA shell (`spaShell()`, for `/`, `/login`, `/user/settings`) plus a JSON API (`/api/books`, `/api/session`, `/api/settings`, operation-start endpoints, etc.). A session middleware resolves the current user from a cookie (in-memory sessions in `sessions.ts`) and wraps handlers in `runWithUser`; `/login` and the account-creation/login writes (`POST /api/users`, `POST /api/session`) are public — everything else 401s a missing session rather than redirecting, since a SPA `fetch()` would otherwise follow a redirect transparently and receive the login page with status 200. Operation-start endpoints (sync/download/convert/prepare) return `{ type, queued }`, then the client subscribes to `GET /api/operation/stream` for progress (visible only to the operation's owner). GET `/download/converted/:asin` streams a converted book as a ZIP; GET `/download/aax/:asin` streams the original AAX file. All ASIN params are validated against `^[A-Z0-9]{10}$`.
- `zip.ts` — Dependency-free store-only streaming ZIP writer (no zip64; 4 GB cap) used for browser downloads.
- `sse.ts` — `sseJsonStream()` bridges `EventReporter` events to the client as named SSE events with JSON payloads (`log`, `progress`, `book`, `done`) for the operation log panel and per-row status.
- `pending-logins.ts` — In-memory, per-user state (serial + PKCE verifier) bridging the two Audible sign-in requests. Deliberately not persisted; an interrupted sign-in is restarted.
- `client/` — The React (19) + TypeScript SPA: Base UI for accessible primitives (Menu, Tabs, Switch, Select, Toast, AlertDialog, Popover), TanStack Table v9 + TanStack Virtual for the books table (sorting, per-column filtering including faceted/date-range/number-range, column visibility/order/sizing, row selection), `@dnd-kit` for the two drag interactions (column reorder, the Settings output-naming chip builder). `theme.css` ports the app's Adwaita-matching look verbatim (same class names as the old server-rendered markup), so the desktop shell keeps looking native. Built by `node scripts/build-client.mjs` (esbuild) into `src/web/static/app.js` + `app.css`, both **committed** — Flathub builds have no network and skip devDependencies (`scripts/generate-flatpak-sources.mjs`), so the built bundle must already exist in git; run the build script and commit the output whenever `src/web/client/` changes. `npm run build:client:watch` rebuilds on change during development. React, Base UI, TanStack and `@dnd-kit` are `devDependencies`, not `dependencies` — the server never imports them, only the build script does.
- `server.ts` (repo root) — Enables HTTP basic auth when `WEB_USER` and `WEB_PASSWORD` are both set.

**Testing**: `test/*.test.ts` are fast unit/route tests (no browser) — route tests exercise the JSON API directly via Hono's `app.request()`. `test/ui/*.test.ts` spawn a real server via `test/ui/fixture.ts` and drive it with Chromium by default, against the *committed* `src/web/static/app.js` build — they exist for behavior the route tests cannot see: the React client actually mounting, drag-and-drop, SSE-driven UI updates, CSP enforcement. `.dockerignore` excludes both. In the dev container Chromium is found at `/opt/pw-browsers/chromium`; override with `CHROMIUM_PATH`. Set `BROWSER=webkit` to run the same suite against WebKit instead (override its executable with `WEBKIT_PATH`) — CI runs both, since the desktop shell embeds WebKitGTK and a Chromium-only suite would miss engine differences. If a host has no Node 24 of its own and you run either suite inside a `flatpak run <runtime>` sandbox to borrow one, `unset FLATPAK_ID` first — Flatpak sets it automatically, and the app treats its presence as a signal it's running as the packaged desktop app, which puts every route behind the per-launch token guard and turns into a wall of unrelated-looking 403s.

**Key patterns**:
- `AudibleLibrary` and `Converter` both accept a `ProgressReporter` via constructor injection — `consoleReporter` for CLI use, `EventReporter` for web use.
- Only one long-running operation (sync or convert) can run at a time, enforced by `operations.ts`.
- External tool dependencies: `audible-cli` (Python, for downloading) and `ffmpeg` (for conversion).

## Configuration

All config is in `.env` (see `.env.example`). Key variables: `AUDIBLE_ACTIVATION_BYTES`, `AUDIBLE_TARGET_DIR`, `AUDIBLE_OUTPUT_DIR`, `DB_PATH`. Audio format/quality (`AudioSettings` in `converter.ts`) is a per-account setting instead, stored on the user record and edited under Settings.

## Docker

The intended deployment is fully sandboxed: `docker-compose.yml` uses a single **named Docker volume** (`users`, mounted at `/data/users`) — no host bind mounts. Each user's data lives under `/data/users/<name>`. The container runs the web server, and users retrieve their books through the web UI's download endpoints rather than from the host filesystem. Audible sign-in happens in the web UI (**Settings → Connect Audible**); the image ships neither Python nor audible-cli.
