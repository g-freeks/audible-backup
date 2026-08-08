# Audible Backup Tool

Backs up your Audible library: syncs the library list, downloads AAX audiobook
files via [audible-cli](https://github.com/mkb79/audible-cli), and converts
them to chapter-split, ID3-tagged MP3s with ffmpeg — all driven from a web UI
with live progress streaming.

The intended deployment is **sandboxed in Docker**: all data (AAX files,
converted MP3s, database, Audible credentials) lives in named Docker volumes
with no host filesystem access. You get your books out through the web UI's
**Download** buttons — converted books as a ZIP of chapter MP3s, or the
original AAX file.

## Quick start (Docker)

```bash
cp .env.example .env   # set AUDIBLE_ACTIVATION_BYTES, WEB_USER, WEB_PASSWORD
docker compose up -d
```

Then log in to Audible once inside the container (credentials persist in the
`audible-auth` volume):

```bash
docker compose exec audible-backup audible quickstart
```

Open http://localhost:3000 — sync your library, download and convert books,
and fetch the results via each book's Download button.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `AUDIBLE_ACTIVATION_BYTES` | Required for AAX decryption (`audible activation-bytes`) | — |
| `WEB_USER` / `WEB_PASSWORD` | Enables HTTP basic auth on the web UI when both are set | unset (no auth) |
| `MP3_QUALITY` | LAME VBR quality (0 best – 9 smallest) | `4` |

> **Security note:** without `WEB_USER`/`WEB_PASSWORD` the web UI is
> unauthenticated and includes destructive actions (deleting downloaded
> files). Set both, and never expose port 3000 directly to the internet.

## Running outside Docker

The CLI and server also run directly on a host with **Node 22**
(`--experimental-strip-types`/`--experimental-sqlite`, no build step),
**ffmpeg**, and **audible-cli** on PATH:

```bash
npm install
cp .env.example .env   # AUDIBLE_TARGET_DIR etc. control where data goes
npm run server         # Web UI on http://localhost:3000
npm run sync           # CLI: download new audiobooks
npm run convert        # CLI: convert AAX to chapter-split MP3s
npm test               # Run the test suite
```

See `node app.ts help` for all CLI commands and flags.

## Limitations

- Only AAX downloads are supported; AAXC-only titles (common on newer Audible
  accounts) are not handled yet.
- Output is chapter-split MP3 only (no single-file M4B option).
- ZIP downloads are store-only (MP3s don't compress) and capped at 4 GB per
  archive.
