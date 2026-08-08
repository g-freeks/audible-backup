# Audible Backup Tool

Backs up your Audible library: syncs the library list, downloads AAX audiobook
files via [audible-cli](https://github.com/mkb79/audible-cli), and converts
them to chapter-split, ID3-tagged MP3s with ffmpeg. Comes with both a CLI and
a web UI with live progress streaming.

> **Security note:** the web UI has no authentication and includes destructive
> actions (deleting downloaded files). Only run it on a trusted network or
> inside the provided Docker setup — never expose port 3000 to the internet.

## Requirements

- **Node 22** (uses `--experimental-strip-types` and `--experimental-sqlite`; no build step)
- **ffmpeg** on PATH
- **audible-cli** on PATH (`pipx install audible-cli`, then `audible quickstart` to log in)
- Your Audible **activation bytes** (e.g. via `audible activation-bytes`)

## Setup

```bash
npm install
cp .env.example .env   # then fill in AUDIBLE_ACTIVATION_BYTES and paths
```

Key `.env` variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `AUDIBLE_ACTIVATION_BYTES` | Required for AAX decryption | — |
| `AUDIBLE_TARGET_DIR` | Where AAX downloads go | `~/Music/audible-backup` |
| `AUDIBLE_OUTPUT_DIR` | Where converted MP3s go | `~/Music/audible-backup/converted` |
| `DB_PATH` | SQLite database location | `~/Music/audible-backup/audiobooks.db` |
| `MP3_QUALITY` | LAME VBR quality (0 best – 9 smallest) | `4` |

## Usage

```bash
npm run sync          # Download new audiobooks
npm run convert       # Convert AAX to chapter-split MP3s
npm run sync-convert  # Both in sequence
npm run status        # Show library status
npm run list          # List books ready for conversion
npm run db-status     # Show database contents
npm run server        # Start the web UI on http://localhost:3000
npm test              # Run the test suite
```

See `node app.ts help` for all CLI commands and flags (single-book download,
ignore/unignore, `--force`, custom directories).

## Docker

```bash
docker compose up -d
```

`docker-compose.yml` mounts volumes for AAX files, converted output, the
database, and your Audible auth directory (`~/.audible`). Run
`audible quickstart` once inside the container (or mount an existing auth
directory) before syncing.

## Limitations

- Only AAX downloads are supported; AAXC-only titles (common on newer Audible
  accounts) are not handled yet.
- Output is chapter-split MP3 only (no single-file M4B option).
