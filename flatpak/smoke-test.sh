#!/usr/bin/env bash
#
# Smoke-tests an installed Audible Backup Flatpak.
#
#   flatpak-builder --user --install --force-clean build \
#     flatpak/io.github.g_freeks.audible_backup.yml
#   flatpak/smoke-test.sh
#
# The unit and browser suites already cover the application. What they cannot
# see is whether the *sandbox* is right: whether the runtime really carries an
# ffmpeg that can do this job, whether the Audible client loads under the
# bundled Node, whether the shell's GTK and WebKit versions resolve, and
# whether the app runs from the layout the manifest installs.

set -euo pipefail

APP=io.github.g_freeks.audible_backup
FAILURES=0

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
pass() { printf '   ok   %s\n' "$1"; }
fail() { printf '   FAIL %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# Run a command inside the sandbox, as the app itself would.
in_app() { flatpak run --command="$1" "$APP" "${@:2}"; }

step "ffmpeg can decode what Audible ships and encode what we produce"
if in_app ffmpeg -hide_banner -version >/dev/null 2>&1; then
  pass "ffmpeg is on PATH inside the sandbox"

  if in_app ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'libmp3lame'; then
    pass "libmp3lame encoder present"
  else
    fail "no libmp3lame encoder — conversion to MP3 is impossible"
  fi

  # AAX and AAXC both carry AAC audio.
  if in_app ffmpeg -hide_banner -decoders 2>/dev/null | grep -qE '^ *[A-Z.]+ +aac +'; then
    pass "aac decoder present"
  else
    fail "no aac decoder — Audible files cannot be read"
  fi
else
  fail "no ffmpeg in the runtime — the manifest needs an ffmpeg module after all"
fi

step "the Audible client loads under the bundled Node"
# The client is TypeScript now — there is no Python in the sandbox at all.
if in_app /app/bin/node --input-type=module -e '
import { getLocale, MARKETPLACES } from "/app/share/audible-backup/src/audible/locale.ts";
import { buildOAuthUrl } from "/app/share/audible-backup/src/audible/login.ts";
const { url } = buildOAuthUrl(getLocale("de"));
if (!url.startsWith("https://www.amazon.de/ap/signin?")) throw new Error("bad sign-in url");
console.log(`   ${MARKETPLACES.length} marketplaces, sign-in URL builds`);
' 2>&1; then
  pass "the Audible client loads and builds a sign-in URL"
else
  fail "the Audible client does not load — type stripping or a bad import"
fi

step "no Python ships in the bundle"
if in_app sh -c '[ ! -d /app/lib/audible-python ]'; then
  pass "the vendored Python packages are gone"
else
  fail "/app/lib/audible-python still exists"
fi

step "the shell's toolkit is present"
# No display needed: this only resolves the typelibs the shell imports. If
# either version is missing, the window would never open.
if in_app gjs -c '
imports.gi.versions.Gtk = "4.0";
imports.gi.versions.WebKit = "6.0";
const Gtk = imports.gi.Gtk, WebKit = imports.gi.WebKit;
print("   GTK " + Gtk.MAJOR_VERSION + "." + Gtk.MINOR_VERSION + ", WebKit " + WebKit.MAJOR_VERSION + "." + WebKit.MINOR_VERSION);
' 2>&1; then
  pass "gjs resolves GTK 4.0 and WebKit 6.0"
else
  fail "gjs cannot load GTK 4.0 / WebKit 6.0 — the shell would not start"
fi

step "the app serves from the layout the manifest installs"
# The app creates its output folder at startup. A CI runner has no XDG user
# directories, so xdg-music resolves to a $HOME/Music that does not exist yet.
mkdir -p "${XDG_MUSIC_DIR:-$HOME/Music}"
LOG=$(mktemp)
# FLATPAK_ID is set inside the sandbox, which is what puts the app in desktop
# mode — no override here, so this tests that detection too.
flatpak run --command=/app/bin/node "$APP" /app/share/audible-backup/server.ts >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

URL=""
for _ in $(seq 1 40); do
  URL=$(grep -o 'AUDIBLE_BACKUP_URL=.*' "$LOG" 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then
  fail "the server never announced a URL"
  sed 's/^/     | /' "$LOG"
else
  pass "server announced its URL and token"

  JAR=$(mktemp)
  STATUS=$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' -L --max-time 20 "$URL" || echo 000)
  if [ "$STATUS" = "200" ]; then
    pass "library page served (HTTP 200)"
  else
    fail "library page returned HTTP $STATUS"
    sed 's/^/     | /' "$LOG"
  fi

  # A page that renders is not a page that works — the shell is a near-empty
  # HTML document, so if the React bundle or its stylesheet 404, the app
  # looks fine and does nothing at all.
  ASSETS_OK=1
  for ASSET in app.js app.css; do
    CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' --max-time 20 \
      "${URL%%\?*}static/$ASSET" || echo 000)
    [ "$CODE" = "200" ] || { fail "/static/$ASSET returned HTTP $CODE"; ASSETS_OK=0; }
  done
  [ "$ASSETS_OK" = "1" ] && pass "the client bundle and stylesheet are served"

  # The token gate is the only thing protecting a loopback server that holds
  # Audible credentials, so a build that lost it must not ship.
  BARE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${URL%%\?*}" || echo 000)
  if [ "$BARE" = "403" ]; then
    pass "requests without the token are refused"
  else
    fail "expected 403 without a token, got $BARE"
  fi
fi

cleanup
trap - EXIT

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[1mAll sandbox checks passed.\033[0m\n'
else
  printf '\033[1m%s check(s) failed.\033[0m\n' "$FAILURES"
fi
exit "$FAILURES"
