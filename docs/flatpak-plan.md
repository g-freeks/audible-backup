# Plan: distributing Audible Backup as a Flatpak

Status: Phases 1–4 and 6 are implemented. Phase 5 (Flathub) is parked.

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
news is that the pieces that matter — the operation pipeline, the Audible
client, the converter, the whole UI — are unaffected. What changes is the shell
around them.

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

### 4. Python stayed, until phase 6

The helper needs `audible` plus its transitive dependencies. Flathub builds have
**no network access**, so every dependency must be declared as a source with a
checksum (`flatpak-pip-generator`). That is tedious but mechanical.

The alternative — porting the Audible client to TypeScript and dropping Python
entirely — would roughly halve the bundle and remove a whole runtime, but it
means reimplementing PKCE login, device registration with RSA-signed ADP tokens,
and AES voucher decryption. That is real cryptographic work and a poor thing to
attempt in the same change as the packaging. Deferred to a later phase —
and done in phase 6, once the packaging was settled.

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
| ffmpeg | apt package | Already in `org.gnome.Platform` — no extension, see Phase 3 |
| npm deps | `npm ci` at build | Vendored from `package-lock.json` by `scripts/generate-flatpak-sources.mjs` (only `hono`, `@hono/node-server`, which have no transitive dependencies) |
| Python deps | `pip install audible-cli` | None — the Audible client is TypeScript as of Phase 6 |
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

**Phase 3 — the manifest** ✅ *done*
- `flatpak/io.github.g_freeks.audible_backup.yml`, on `org.gnome.Platform` 50
- `scripts/generate-flatpak-sources.py` writes both offline module files;
  they are generated and committed, never hand-edited
- Permissions: `--share=network`, `--share=ipc`, `--socket=wayland`,
  `--socket=fallback-x11`, `--device=dri`, `--filesystem=xdg-music:create`
- Install layout the shell already assumed: `/app/bin/node`,
  `/app/share/audible-backup/server.ts`, `/app/bin/audible-backup`

*ffmpeg needs no extension.* The open question was whether
`org.freedesktop.Platform.ffmpeg-full` ships the CLI and libmp3lame. It turns
out not to matter: freedesktop-sdk's `elements/platform.bst` — which the GNOME
runtime is built on — already includes `components/ffmpeg.bst` and
`components/lame.bst`, that build passes `--enable-libmp3lame` with no
`--disable-programs`, and its codec allowlist contains both the `aac` decoder
and the `libmp3lame` encoder. That is exactly what AAX/AAXC to MP3 needs, so
the base runtime's `/usr/bin/ffmpeg` is enough and no extension is declared.
The same stack ships `python3` and `flatpak-xdg-utils`, which is what makes the
`xdg-open` in "Open folder" work.

*npm vendoring needs no generator tool.* There are exactly two production
packages and they have no transitive dependencies, so the sources are derived
straight from `package-lock.json` — including converting npm's base64
`integrity` to the hex checksum flatpak wants. This cannot disagree with what
`npm ci` installs, and `test/flatpak.test.ts` fails if the two drift.

*Python is 15 packages, and only one is awkward.* Thirteen are pure-Python
wheels that work on any interpreter and architecture. `pbkdf2` and `pyaes`
ship only an sdist, and `pyaes` still says `from distutils.core import setup` —
distutils was removed in Python 3.12, so that build only works through
setuptools' compatibility shim. Rather than depend on whichever setuptools the
SDK carries, a pinned setuptools/wheel/packaging trio is vendored, installed
into a `_buildtools` directory under the build tree, and put on `PYTHONPATH`
for the real install. It never reaches `/app`.

*Pillow is the fragile pin.* It is the only compiled dependency and ships no
`abi3` wheels, so it is pinned per architecture **and** per CPython version
(`cp313`, matching freedesktop-sdk 25.08). A runtime that moved to another
Python would fail this build loudly — pip would find no matching wheel — rather
than silently, which is the acceptable version of this problem.

Everything is installed with `pip --target=/app/lib/audible-python` and reached
through `--env=PYTHONPATH=...`, so no path anywhere encodes a Python version.

What was actually verified here, without flatpak-builder:
- Every one of the 18 pinned URLs was downloaded and its checksum recompared
- The generated build commands were run offline against the staged sources and
  produced a working install — including compiling both sdists, on a machine
  whose *system* setuptools cannot build them, which is the case the vendored
  build tools exist for
- The resulting tree was assembled into the layout the manifest produces, and
  the server booted from it and served its pages, with the Python helper
  reporting itself available

`audible` falls back to its pure-Python crypto (`pyaes`, `rsa`, `pbkdf2`) and
says so in a warning. Its faster backends are optional extras that would add a
compiled dependency; the data being decrypted is a small voucher, so the slow
path is not worth another arch-specific wheel.

**Phase 4 — build and verify** ✅ *done*
- `.github/workflows/flatpak.yml` builds the manifest with `flatpak-builder`
- `flatpak/smoke-test.sh` checks the sandbox, not the app
- The bundle is uploaded as a CI artifact, and attached to the GitHub release
  on version tags (x86_64 only; aarch64 needs QEMU emulation and takes hours)

The job installs `flatpak-builder` from apt rather than using a prebuilt
action image, because that would mean guessing at an image tag for GNOME 50.
`--install-deps-from=flathub` then resolves the runtime, the SDK and the node
extension at whatever branches the manifest actually needs, which is also what
settles the two questions Phase 3 left open — if GNOME 50 or the node24
extension does not exist, this step fails and says so.

The smoke test is deliberately not a second copy of the test suite. Everything
in it is a property of the *sandbox* that no unit or browser test can see:

| Check | The assumption it settles |
| --- | --- |
| `ffmpeg` runs, has `libmp3lame` and an `aac` decoder | that the runtime's ffmpeg can do this job without an extension |
| the vendored Python stack imports | that the Pillow wheel's `cp313` tag matches the runtime's interpreter |
| the helper answers on its protocol | that `PYTHONPATH` and the helper's install path are right |
| `gjs` resolves GTK 4.0 and WebKit 6.0 | that the shell's toolkit exists — checked without a display |
| the app serves, and refuses requests without a token | that the install layout works and the loopback gate survived packaging |

The store metadata is validated in the same job with `appstreamcli validate`
and `desktop-file-validate` — the checks Flathub itself runs. Both already
pass.

The first run of this job (PR #22) settled everything Phase 3 had to assume:

| Assumption | What the sandbox reported |
| --- | --- |
| `org.gnome.Platform//50` and the `node24` SDK extension exist | the build resolved and installed both |
| the runtime ships Python 3.13, matching the Pillow pin | `python 3.13.15, audible 0.12.0, pillow 12.3.0` |
| the runtime's ffmpeg suffices, with no extension | `libmp3lame` encoder and `aac` decoder both present |
| gjs can load the shell's toolkit | `GTK 4.22, WebKit 2.52` — that is WebKitGTK's own version; the API is 6.0 |
| the install layout works | the app served HTTP 200 with its token, 403 without |

The bundle is **22 MB**, not the 200–300 MB estimated in the risks below: the
GNOME runtime is a dependency that Flatpak shares between apps, not something
copied into the bundle. Only Node, the vendored Python packages and the app
itself are actually shipped.

The shell's *window* cannot be tested here — opening a real WebKitGTK window
needs a display, and a headless X server on a CI runner tests the runner more
than the app. It has since been confirmed by hand: the window opens, Audible
sign-in completes through the system browser, and the library and conversion
controls work.

That first real launch found the one bug none of this could: `serveStatic`
resolves its root against the process's working directory, so a desktop
launch — which starts the server from wherever the session began — served
every client script as a 404. The page still rendered and plain HTML forms
still worked, so signing in succeeded while every htmx-driven button silently
did nothing. The root is now resolved against `server.ts`,
`test/server-static.test.ts` covers it with a real process, and the smoke test
fetches the scripts rather than trusting that the page returned 200.

**Phase 5 — Flathub submission**
- PR to `flathub/flathub` with the manifest
- Address reviewer feedback

**Phase 6 — drop Python** ✅ *done*
- The Audible client is now TypeScript (`src/audible/`): marketplaces, PKCE
  sign-in and device registration, credential storage and ADP request signing,
  the API, and licence-voucher decryption
- `pyhelper.ts` dispatches to it and returns the same JSON events the Python
  helper did, so no caller changed
- The Flatpak vendors no Python packages, declares no `PYTHONPATH`, and does
  not ship the helper

This was the phase with the least room for guessing: PKCE, the OAuth URL, the
ADP signature and the voucher either match what Amazon expects exactly or fail
in production, and none of it can be exercised without a real account. So the
port is checked against the implementation it replaces.
`scripts/generate-audible-vectors.py` runs the real `audible` package to
produce `test/resources/audible-vectors.json`, and `test/audible.test.ts`
holds the TypeScript to it:

| Checked against Python | How |
| --- | --- |
| PKCE challenge, client id | same derivation from the same fixed inputs |
| OAuth sign-in URL | byte-for-byte, four marketplaces, parameter order included |
| ADP request signature | our signature verifies against the string *Python* signed |
| RSA algorithm agreement | Node verifies a signature Python produced |
| Signature date format | Python's odd `…+00:00Z` with microseconds, reproduced |
| Licence voucher | we decrypt a voucher Python encrypted, and fail on any wrong input |

The fixture records only a *public* key, so nothing secret is committed.

Device registration is the one part no vector can cover — it needs a live
Amazon exchange. It has since been confirmed by hand: a **clean install** of
the TypeScript build signed in successfully and downloaded a book, which
exercises registration, the signed API requests and the voucher end to end.
`helper/audible_helper.py` stays in the repository, and `AUDIBLE_HELPER` still
routes to it, as an escape hatch for server installs.

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
3. ~~**ffmpeg availability.**~~ *Resolved in Phase 3.* The base runtime already
   carries an `ffmpeg` built with `--enable-libmp3lame`, an `aac` decoder and no
   `--disable-programs`, so no extension is needed at all.
4. ~~**Runtime and SDK-extension versions.**~~ *Resolved in Phase 4.* The
   original plan named `org.freedesktop.Platform`, which ships neither
   WebKitGTK nor GJS; the shell needs `org.gnome.Platform`, which has both.
   The first CI build confirmed that GNOME 50 and
   `org.freedesktop.Sdk.Extension.node24` both resolve, and that the runtime
   ships Python 3.13 — matching the `cp313` Pillow pin. If a future runtime
   moves to another Python, the build fails on the missing wheel; re-run the
   generator with `--python-version` and commit the result.
5. ~~**Bundle size.**~~ *Measured in Phase 4: 22 MB.* The estimate assumed the
   runtime counted; it does not — Flatpak shares it between apps, and ffmpeg
   and Python come from it rather than from the bundle.
6. **Browser tests don't run inside the sandbox.** The existing suites keep
   running against the plain server in CI; the Flatpak job only smoke-tests.

## Rough effort

| Phase | Estimate |
| --- | --- |
| 1 — desktop-shaped app | ✅ done |
| 2 — desktop integration + shell | ✅ done |
| 3 — manifest and offline sources | ✅ done |
| 4 — CI and verification | ✅ done |
| 5 — Flathub submission | unpredictable; days to weeks of review latency |
| 6 — drop Python (optional) | 3–5 days |

Phases 1 and 2 are useful on their own: they make the app pleasanter to run
outside Docker regardless of whether the Flatpak ever ships.
