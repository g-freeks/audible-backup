# Plan: distributing Audible Backup as a Flatpak

Status: Phases 1 and 2 are implemented. Phases 3–6 are still a proposal.

## Goal

`flatpak install io.github.g_freeks.audible_backup` gives a desktop user a
windowed app that syncs their Audible library and produces chapter-split MP3s,
with no Docker, no terminal, and no manual `audible quickstart`.

## The central tension

The app is currently a **multi-tenant network service**: a Hono server on port
3000, several users with isolated directories, session cookies, and files
retrieved through the browser as ZIPs. Flatpak distributes **single-user desktop
applications**: one window, one user, per-user data under
`~/.var/app/<app-id>/`, no daemon, and a sandbox that must declare every
permission it wants.

Almost all of the work below follows from reconciling those two shapes. The good
news is that the pieces that matter — the operation pipeline, the Python helper,
the converter, the whole UI — are unaffected. What changes is the shell around
them.

## Architectural decisions

### 1. Presentation: keep the web UI, wrap it in a window

| Option | Verdict |
| --- | --- |
| Server + open the user's browser via `xdg-open` | Rejected. An app with no window is a poor Flatpak citizen and invites review pushback. |
| **Thin WebKitGTK shell that loads `127.0.0.1:<port>`** | **Chosen.** ~250 lines of GJS (`desktop/audible-backup`). Real window, icon, taskbar entry; the entire existing UI is reused unchanged. |
| Rewrite the UI in GTK | Rejected. Throws away everything for no user-visible gain. |

The shell owns the lifecycle: spawn Node on a random free port, wait for it to
listen, load the page, and kill the server on window close.

### 2. Multi-tenancy: dormant, not deleted

A Flatpak instance is already per-desktop-user, and the sandbox is the isolation
boundary. Running the multi-user machinery inside it would be redundant and
confusing (a login screen for a single-user app).

The app already has **legacy single-user mode** — it is what runs when no users
are registered — so the Flatpak build simply never registers one. The user menu,
login page and session middleware are hidden when `FLATPAK_ID` is set. The code
stays for server deployments; this is a conditional, not a removal.

### 3. Storage: XDG paths, plus a visible output directory

`config.ts` currently resolves paths from env vars with `~/Music/...`
fallbacks. Under Flatpak those must become:

| Data | Location |
| --- | --- |
| Database, AAX/AAXC files, Audible credentials | `$XDG_DATA_HOME/` (i.e. `~/.var/app/<id>/data/`) |
| Converted MP3s | `$XDG_MUSIC_DIR/Audiobooks`, with `--filesystem=xdg-music:create` |

Converted output deliberately lands outside the sandbox: on a desktop the whole
point is that the files are *yours*, and forcing a ZIP download through the
browser to reach your own disk would be absurd. The existing download endpoints
stay (harmless, still useful when self-hosting) but the desktop UI should offer
"Open folder" via the portal instead.

A stricter alternative is to keep everything sandboxed and export through the
file-chooser portal. That is more idiomatic and less convenient; worth revisiting
if Flathub reviewers object to the blanket `xdg-music` permission.

### 4. Python stays, for now

The helper needs `audible` plus its transitive dependencies. Flathub builds have
**no network access**, so every dependency must be declared as a source with a
checksum (`flatpak-pip-generator`). That is tedious but mechanical.

The alternative — porting the Audible client to TypeScript and dropping Python
entirely — would roughly halve the bundle and remove a whole runtime, but it
means reimplementing PKCE login, device registration with RSA-signed ADP tokens,
and AES voucher decryption. That is real cryptographic work and a poor thing to
attempt in the same change as the packaging. Deferred to a later phase.

`audible-cli` is **not** bundled: the helper covers everything the desktop build
needs, and shipping a second Python entry point purely as a fallback is dead
weight. Its absence must degrade to a clear message, not a crash.

### 5. Localhost is not a security boundary

Any process on the machine can reach `127.0.0.1:<port>`, and the app holds
Audible credentials. Mitigations, in order of preference:

1. Bind to `127.0.0.1` only — never `0.0.0.0` (today's default binds broadly).
2. Random high port per launch.
3. A per-launch secret the shell injects as a cookie, required by a middleware.

(1) and (2) are trivial. (3) is a small middleware and worth doing, since the
existing basic-auth option is aimed at a different threat model.

## Technology changes at a glance

| Concern | Today | Flatpak build |
| --- | --- | --- |
| Runtime | `node:24-bookworm-slim` image | `org.gnome.Platform` 50 + `org.freedesktop.Sdk.Extension.node24` at build time, Node binary copied into `/app` |
| ffmpeg | apt package | `org.freedesktop.Platform.ffmpeg-full` extension — **must verify it ships the `ffmpeg` binary and libmp3lame**, else build a minimal ffmpeg from source |
| npm deps | `npm ci` at build | Vendored offline via `flatpak-node-generator` (only `hono`, `@hono/node-server`; `playwright-core` is a devDependency and excluded) |
| Python deps | `pip install audible-cli` | Vendored offline via `flatpak-pip-generator` |
| Entry point | `node server.ts` | GJS shell → spawns `node server.ts` → WebKitGTK window |
| Config | env vars, `.env` | XDG dirs, `FLATPAK_ID` detection; `.env` unused |
| Users | multi-tenant | single-user (legacy mode), user UI hidden |
| Distribution | GHCR image | Flathub (plus GitHub Releases `.flatpak` bundles) |
| Window toolkit | none | GTK 4 + WebKitGTK 6.0, both from the GNOME runtime |

## Phases

**Phase 1 — make the app desktop-shaped** ✅ *done*
- XDG-aware defaults in `config.ts`, gated on `FLATPAK_ID` (or `AUDIBLE_DESKTOP=1`)
- Binds `127.0.0.1` and defaults to port 0, printing `AUDIBLE_BACKUP_URL=…` for the launcher to read
- Per-launch token, presented once in the URL and then held as a cookie
- One implicit user (`DESKTOP_USER`), no login screen, no account controls in the UI
- Clear error when the Python helper is unavailable (already done earlier)

Try it without any Flatpak tooling:

```bash
AUDIBLE_DESKTOP=1 npm run server
# -> AUDIBLE_BACKUP_URL=http://127.0.0.1:43177/?token=…
```

Data lands in `$XDG_DATA_HOME/audible-backup`, converted books in
`$XDG_MUSIC_DIR/Audiobooks`. Nothing changes for Docker or server installs:
desktop mode is off unless `FLATPAK_ID`/`AUDIBLE_DESKTOP` is set, and explicit
environment variables still win in every mode.

**Phase 2 — desktop integration** ✅ *done*
- `desktop/io.github.g_freeks.audible_backup.desktop`
- `desktop/io.github.g_freeks.audible_backup.metainfo.xml` (AppStream: summary,
  description, screenshots at raw.githubusercontent URLs, release notes,
  license, content rating, branding colours)
- Icons: scalable SVG plus rendered 128px and 256px PNGs
  (`node scripts/render-icons.mjs` after editing the SVG)
- Screenshots taken from the running app in desktop mode
  (`node scripts/capture-screenshots.mjs`), so the store listing cannot drift
  from reality
- The GJS/WebKitGTK shell, `desktop/audible-backup`

The shell spawns the server, waits for its `AUDIBLE_BACKUP_URL=` line, and shows
that URL in a `WebKit.WebView`. Three behaviours are worth knowing:

- **External links leave the window.** Anything outside the server's own origin
  — above all the Audible sign-in page — is handed to `Gtk.UriLauncher`, so it
  opens in the user's real browser where their Amazon session and password
  manager already are.
- **The server's death is visible.** `wait_async` on the subprocess swaps the
  window over to an error page carrying the tail of the server log, rather than
  leaving a dead white page.
- **Closing the window stops the server**, so no headless Node process is left
  holding the database.

Desktop mode also stopped pushing a ZIP at the browser once a book is ready:
the MP3s are already in the music folder, so the topbar offers **Open folder**
instead, which shells out to `xdg-open` — the portal shim inside Flatpak.

The `.desktop` file, the AppStream metadata, the icons and the shell are all
checked by `test/desktop-files.test.ts`, which is the only thing standing
between a renamed app ID and a broken Flathub build.

This phase cannot be fully verified here: there is no `gjs` or WebKitGTK in the
dev container, so the shell is unrun. Its first real execution will be the
Phase 4 smoke test.

**Phase 3 — the manifest**
- `io.github.g_freeks.audible_backup.yml`, on `org.gnome.Platform` 50
- Generated offline source manifests for npm and pip
- ffmpeg resolution (extension vs. source build)
- Permissions: `--share=network`, `--socket=wayland`, `--socket=fallback-x11`,
  `--device=dri`, `--filesystem=xdg-music:create`
- Install layout the shell already assumes: `/app/bin/node`,
  `/app/share/audible-backup/server.ts`, and the shell itself as
  `/app/bin/audible-backup`

**Phase 4 — build and verify**
- `flatpak-builder` job in CI via `flatpak/flatpak-github-actions`
- Smoke test: build, install, launch headless, assert the server answers
- Publish `.flatpak` bundles on GitHub Releases (x86_64; aarch64 is slow under QEMU emulation and may be a follow-up)

**Phase 5 — Flathub submission**
- PR to `flathub/flathub` with the manifest
- Address reviewer feedback

**Phase 6 (optional) — drop Python**
- Port the Audible client to TypeScript; removes a runtime and roughly halves the bundle

## Risks and open questions

1. ~~**App ID vs. repository name.**~~ *Resolved.* Flathub maps `-` in the ID to
   `_`, and expects the ID to reflect the repository URL. The repository was
   renamed to `audible-backup`, so `io.github.g_freeks.audible_backup` now maps
   back correctly; GitHub redirects the old `audible_backup` URL. The app ID is
   settled and can be baked into file names from Phase 2 onwards.
2. **Flathub review of a DRM-adjacent app.** The app decrypts purchased
   audiobooks. Framing it around personal backups of your own purchases (as the
   README already does) helps, but there is a real chance of rejection. The
   fallback — GitHub Releases bundles, or a self-hosted Flatpak repo — should be
   treated as an acceptable outcome, not a failure.
3. **ffmpeg availability** is a hard blocker if `ffmpeg-full` lacks the CLI or
   libmp3lame. Verify in Phase 3 before building anything else on it.
4. **Runtime and SDK-extension versions.** The plan originally named
   `org.freedesktop.Platform`, which ships neither WebKitGTK nor GJS; the shell
   needs `org.gnome.Platform`, which has both. GNOME 48 went end-of-life in
   March 2026, so the manifest targets 50. The matching
   `org.freedesktop.Sdk.Extension.node24` branch has to line up with the
   freedesktop base that GNOME 50 is built on — confirm the exact branch when
   writing the manifest rather than assuming `24.08`.
5. **Bundle size.** Node plus Python plus ffmpeg is likely 200–300 MB. Acceptable
   but worth measuring.
6. **Browser tests don't run inside the sandbox.** The existing suites keep
   running against the plain server in CI; the Flatpak job only smoke-tests.

## Rough effort

| Phase | Estimate |
| --- | --- |
| 1 — desktop-shaped app | ✅ done |
| 2 — desktop integration + shell | ✅ done |
| 3 — manifest and offline sources | 2–3 days (most of the pain: pip/npm vendoring, ffmpeg) |
| 4 — CI and verification | 1 day |
| 5 — Flathub submission | unpredictable; days to weeks of review latency |
| 6 — drop Python (optional) | 3–5 days |

Phases 1 and 2 are useful on their own: they make the app pleasanter to run
outside Docker regardless of whether the Flatpak ever ships.
