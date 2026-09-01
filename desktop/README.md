# Desktop integration

Everything needed to ship Audible Backup as a desktop application, rather than
a server you point a browser at. See [`../docs/flatpak-plan.md`](../docs/flatpak-plan.md)
for how this fits into the Flatpak work.

| File | Purpose |
| --- | --- |
| `audible-backup` | GJS shell: starts the server, shows it in a WebKitGTK window, stops it on close |
| `io.github.g_freeks.audible_backup.desktop` | Application launcher entry |
| `io.github.g_freeks.audible_backup.metainfo.xml` | AppStream metadata for the Flathub listing |
| `icons/` | Scalable SVG plus rendered 128px and 256px PNGs |
| `screenshots/` | Store screenshots, captured from the running app |

## Development loop

Three tiers, fastest first. Pick the cheapest one that can show the thing you
changed.

| | Command | Window | Sandbox | Engine |
| --- | --- | --- | --- | --- |
| **1** | `AUDIBLE_DESKTOP=1 npm run server` | no (use a browser) | no | your browser |
| **2** | `./desktop/audible-backup` | yes | no | WebKitGTK |
| **3** | `desktop/dev-run.sh` | yes | yes | WebKitGTK |

Tier 3 runs the *installed* Flatpak against your working tree, so you keep the
real permissions and portals without rebuilding. It bypasses packaging
entirely, so anything touching the manifest — permissions, what lands in
`/app` — still needs a real build:

```bash
flatpak-builder --user --install --force-clean build \
  flatpak/io.github.g_freeks.audible_backup.yml
flatpak/smoke-test.sh
```

Note tier 3 uses the app's real data directory, credentials included.

## Screenshots of the real window

```bash
desktop/screenshot-window.sh [output.png] [--full] [--wait SECONDS]
```

The window is the one thing no test suite can show: it needs a display, a
compositor and the real WebKitGTK. Linux has no single way to capture one, so
the script tries `gnome-screenshot`, `spectacle`, `grim` and ImageMagick's
`import` in turn, prints which it used, and names what to install if none are
present.

## Running the shell from a checkout

You need **gjs**, **GTK 4** and **WebKitGTK 6.0** on the system (on Debian and
Ubuntu: `gjs libgtk-4-1 libwebkitgtk-6.0-4`), plus the usual Node 24 and ffmpeg:

```bash
./desktop/audible-backup
```

It finds `server.ts` relative to itself and runs it with `AUDIBLE_DESKTOP=1`, so
data lands in `$XDG_DATA_HOME/audible-backup` and converted books in
`$XDG_MUSIC_DIR/Audiobooks`. Two environment variables override what it starts,
which is how the Flatpak build points it at bundled copies:

- `AUDIBLE_BACKUP_NODE` — the Node binary (defaults to `/app/bin/node`, else `node`)
- `AUDIBLE_BACKUP_SERVER` — the server entry point (defaults to
  `/app/share/audible-backup/server.ts`, else `../server.ts`)

The server's own output is echoed to stderr prefixed with `[server]`, so
`./desktop/audible-backup 2>&1 | less` is the way to debug a launch.

## Regenerating assets

Both write into this directory and the results are committed:

```bash
node scripts/render-icons.mjs        # icons/*/*.png from icons/scalable/*.svg
node scripts/capture-screenshots.mjs # screenshots/*.png from a real server
```

`test/desktop-files.test.ts` checks that the app ID, the icon sizes, and the
screenshot URLs in the metainfo all still agree with what is on disk.

## Building the Flatpak

The manifest lives in [`../flatpak/`](../flatpak/):

```bash
flatpak-builder --user --install --force-clean build \
  flatpak/io.github.g_freeks.audible_backup.yml
flatpak run io.github.g_freeks.audible_backup
```

Its dependency module is generated and committed — regenerate it after
changing `package-lock.json`:

```bash
node scripts/generate-flatpak-sources.mjs
```

`test/flatpak.test.ts` fails if the generated files fall behind the lockfile,
which is the mistake that otherwise only shows up as a failed Flathub build.

After installing, check the sandbox itself:

```bash
flatpak/smoke-test.sh
```

It verifies the things only a real sandbox can answer — that the runtime's
ffmpeg has libmp3lame and an aac decoder, that the Audible client loads under
the bundled Node, that no Python is left in the bundle, that gjs resolves
GTK 4.0 and WebKit 6.0, and that the app serves while still refusing requests
that carry no token. CI runs the same script on every change that can affect
the bundle.
