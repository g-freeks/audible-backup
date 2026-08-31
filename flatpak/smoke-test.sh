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
# ffmpeg that can do this job, whether the Pillow wheel pinned in the manifest
# matches the runtime's Python, whether the shell's GTK and WebKit versions
# resolve, and whether the app runs from the layout the manifest installs.
#
# Every check here is one of the assumptions phase 3 could not verify.

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

step "the vendored Python stack imports under the runtime's interpreter"
# This is where a wrong Pillow pin shows up: the wheel is tied to one CPython
# version, so if the runtime moved, PIL is the import that fails.
if in_app python3 -c '
import sys
import audible, PIL
from audible.login import build_oauth_url, create_code_verifier, extract_code_from_url
from audible.register import register
from audible.aescipher import decrypt_voucher_from_licenserequest
from audible.localization import Locale
print(f"   python {sys.version.split()[0]}, audible {audible.__version__}, pillow {PIL.__version__}")
' 2>&1; then
  pass "audible, Pillow and every symbol the helper imports"
else
  fail "the vendored Python packages do not import — check the Pillow wheel's cp tag"
fi

step "the helper answers on its own protocol"
if in_app python3 /app/share/audible-backup/helper/audible_helper.py login-status \
    | grep -q '"ok": true'; then
  pass "helper reports a usable, unlinked Audible config"
else
  fail "helper did not return a well-formed status"
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

  # A page that renders is not a page that works. Every button in the UI is
  # htmx-driven, so if these 404 the app looks fine and does nothing at all.
  ASSETS_OK=1
  for SCRIPT in htmx.min.js app.js sse.js; do
    CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' --max-time 20 \
      "${URL%%\?*}static/$SCRIPT" || echo 000)
    [ "$CODE" = "200" ] || { fail "/static/$SCRIPT returned HTTP $CODE"; ASSETS_OK=0; }
  done
  [ "$ASSETS_OK" = "1" ] && pass "every client script is served"

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
