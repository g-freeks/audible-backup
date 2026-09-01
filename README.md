# Audible Backup Tool

Backs up Audible libraries: syncs the library list, downloads AAX audiobook
files via [audible-cli](https://github.com/mkb79/audible-cli), and converts
them to chapter-split, ID3-tagged MP3s with ffmpeg — all driven from a web UI
with live progress streaming.

The app is **multi-tenant**: each user has their own Audible account
credentials, activation bytes, library, and converted output, with an
optional per-user password and a user switcher in the UI.

The intended deployment is **sandboxed in Docker**: all data lives in a named
Docker volume with no host filesystem access. You get your books out through
the web UI's **Download** buttons — converted books as a ZIP of chapter MP3s,
or the original AAX file.

## Quick start (Docker)

CI publishes a multi-arch image (amd64/arm64) to GitHub Container Registry on
every push to `main`:

```bash
docker compose up -d          # pulls ghcr.io/g-freeks/audible-backup:latest
# or build from source instead:
docker compose build && docker compose up -d
```

Open http://localhost:3000 — you'll be asked to create the first user
(password optional). Then connect that user's Audible account from
**Settings → Connect Audible**:

1. Pick your marketplace and press **Start sign-in**.
2. Open the link that appears and sign in **on Audible's own page** — this app
   never sees your password, and 2FA/CAPTCHA are handled by Amazon.
3. Afterwards your browser lands on a page that fails to load. That's expected:
   copy its full address and paste it back into the form.

Credentials persist in the volume, so this is a one-time step per user.

Activation bytes are only needed for legacy `.aax` files; if you have them,
paste them into **Settings**. After that: sync, download, convert, and fetch
results via each book's Download button. Additional users are added from the user menu in the top
bar; switching users is a dropdown away.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `USERS_DIR` | Root directory for per-user data | `/data/users` in Docker |
| `AUDIBLE_ACTIVATION_BYTES` | Fallback activation bytes for users without their own | — |
| `WEB_USER` / `WEB_PASSWORD` | Optional HTTP basic auth gate in front of the whole app | unset |
| `MP3_QUALITY` | LAME VBR quality (0 best – 9 smallest) | `4` |

> **Security note:** per-user passwords protect libraries from each other,
> but anyone who can reach the app can create a user. Set
> `WEB_USER`/`WEB_PASSWORD` as an outer gate, and never expose port 3000
> directly to the internet.

## Running outside Docker

The CLI and server also run directly on a host with **Node 24+**
(TypeScript runs natively via type stripping — no build step, no flags),
**ffmpeg**, and **audible-cli** on PATH:

```bash
npm install
cp .env.example .env
npm run server                    # Web UI on http://localhost:3000
node app.ts sync --user alice     # CLI as a registered user
npm run sync                      # CLI in legacy single-user mode (.env paths)
npm test                          # Run the test suite
```

Until the first user is created, the app runs in legacy single-user mode
using the `.env`-configured paths. See `node app.ts help` for all CLI
commands and flags.

## Desktop app

There is a desktop shell — a real window with its own icon, no terminal and no
browser tab — intended for eventual Flatpak distribution. It needs **gjs**,
**GTK 4** and **WebKitGTK 6.0** alongside Node 24 and ffmpeg:

```bash
./desktop/audible-backup
```

In this mode the app runs as a single user with no login, keeps its data in
`$XDG_DATA_HOME/audible-backup`, and writes finished audiobooks straight to
`$XDG_MUSIC_DIR/Audiobooks` — no ZIP download needed. See
[`desktop/README.md`](desktop/README.md) and
[`docs/flatpak-plan.md`](docs/flatpak-plan.md).

## Legal

This tool is for **personal backups of audiobooks you own**. It uses your
own Audible account and your own activation bytes to convert your purchases
into a format you control — the same personal-use decryption that tools like
audible-cli and ffmpeg support. Do not use it to share, distribute, or
circumvent DRM on content you have not purchased, and be aware that removing
DRM may be restricted by law in your jurisdiction and by Audible's terms of
service.

## AAXC support

Signing in, listing the library and downloading are handled by a built-in
Audible client (`src/audible/`) written in TypeScript — **no Python needed**.
It fetches the licence voucher and downloads books in AAXC format, including
titles that are AAXC-only on newer Audible accounts. Conversion decrypts AAXC
with the per-file voucher key/iv, so **activation bytes are only needed for
legacy `.aax` files**.

The client is a port of the [`audible`](https://github.com/mkb79/Audible)
Python package, and is tested against vectors that package generated, so the
PKCE sign-in, the signed API requests and the voucher decryption provably
agree with it. The original Python helper is still in the repository: set
`AUDIBLE_HELPER="python3 helper/audible_helper.py"` to use it instead, if you
have the `audible` package installed. Neither the Docker image nor the Flatpak
ships Python, so that path means running from a source checkout.

## Limitations

- Output is chapter-split MP3 only (no single-file M4B option).
- ZIP downloads are store-only (MP3s don't compress) and capped at 4 GB per
  archive.
- One long-running operation (sync/download/convert) at a time across all
  users.
