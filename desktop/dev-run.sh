#!/usr/bin/env bash
#
# Runs the *installed* Flatpak against your working tree.
#
#   desktop/dev-run.sh
#
# The point is to keep the sandbox — the real permissions, the real portals,
# the real WebKitGTK — while skipping the rebuild. The shell reads
# AUDIBLE_BACKUP_SERVER to decide what to start, so pointing it at the checkout
# and granting the sandbox access to that directory is enough.
#
# Use this for application changes. Anything that alters the *packaging* —
# the manifest, permissions, what gets installed into /app — needs a real
# build, because this deliberately bypasses all of it:
#
#   flatpak-builder --user --install --force-clean build \
#     flatpak/io.github.g_freeks.audible_backup.yml
#
# Note this uses the app's real data directory, credentials included. That is
# usually what you want when developing; for a throwaway state, run the server
# directly instead (AUDIBLE_DESKTOP=1 npm run server) with XDG_DATA_HOME set.

set -euo pipefail

APP=io.github.g_freeks.audible_backup
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }
note() { printf '\033[1m%s\033[0m\n' "$1"; }

command -v flatpak >/dev/null || die "flatpak is not installed"

if ! flatpak info "$APP" >/dev/null 2>&1; then
  die "$APP is not installed. Build it first:
  flatpak-builder --user --install --force-clean build \\
    flatpak/io.github.g_freeks.audible_backup.yml"
fi

# The tree's own node_modules is what Node will resolve against, since the
# server is being run from here rather than from /app.
[ -d "$ROOT/node_modules" ] || die "no node_modules in the checkout — run 'npm ci' first"
[ -f "$ROOT/server.ts" ] || die "no server.ts in $ROOT"

note "Running $APP from $ROOT"
echo "  sandbox:  yes (real permissions and portals)"
echo "  packaging: bypassed — rebuild to test manifest changes"
echo

# --filesystem grants this run access to the checkout; AUDIBLE_BACKUP_SERVER
# tells the shell to start that copy instead of the installed one.
exec flatpak run \
  --filesystem="$ROOT" \
  --env=AUDIBLE_BACKUP_SERVER="$ROOT/server.ts" \
  "$APP" "$@"
