#!/usr/bin/env bash
#
# Captures the running Audible Backup window.
#
#   desktop/screenshot-window.sh [output.png] [--full] [--wait SECONDS]
#
# Screenshots of the *actual* window are the one thing neither the test suites
# nor a remote session can produce: they need a display, a compositor and the
# real WebKitGTK. This wraps whichever capture tool the desktop happens to
# provide, so the artifact is comparable whoever runs it.
#
# Linux screenshotting is not uniform — GNOME, KDE, wlroots and plain X11 each
# want a different tool, and on Wayland an application cannot simply grab its
# own window. So this tries them in order and says which one it used, rather
# than failing with something inscrutable.
#
#   --full   capture the whole screen instead of just the window
#   --wait   seconds to wait before capturing, to let the window settle

set -euo pipefail

APP=io.github.g_freeks.audible_backup
OUT=""
FULL=0
WAIT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --wait) WAIT="${2:?--wait needs a number}"; shift 2 ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    *) OUT="$1"; shift ;;
  esac
done
OUT="${OUT:-audible-backup-$(date -u +%Y%m%dT%H%M%SZ).png}"

note() { printf '\033[1m%s\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

if ! flatpak ps 2>/dev/null | grep -q "$APP" && ! pgrep -f "$APP" >/dev/null 2>&1; then
  printf '\033[1;33mwarning:\033[0m %s does not look like it is running.\n' "$APP" >&2
  printf '         Start it with "flatpak run %s" or desktop/dev-run.sh first.\n' "$APP" >&2
fi

[ "$WAIT" -gt 0 ] 2>/dev/null && sleep "$WAIT"

session="${XDG_SESSION_TYPE:-unknown}"
note "Capturing (${session} session) -> $OUT"

captured=""

# GNOME, on both X11 and Wayland. -w grabs the focused window.
if [ -z "$captured" ] && have gnome-screenshot; then
  if [ "$FULL" = "1" ]; then
    gnome-screenshot -f "$OUT" && captured="gnome-screenshot"
  else
    gnome-screenshot -w -f "$OUT" && captured="gnome-screenshot -w"
  fi
fi

# KDE. -a is the active window, -b removes the frame, -n skips the notification.
if [ -z "$captured" ] && have spectacle; then
  if [ "$FULL" = "1" ]; then
    spectacle -f -b -n -o "$OUT" && captured="spectacle -f"
  else
    spectacle -a -b -n -o "$OUT" && captured="spectacle -a"
  fi
fi

# wlroots compositors (sway, Hyprland). grim has no notion of a window, so a
# window capture needs the compositor to name the geometry.
if [ -z "$captured" ] && have grim; then
  if [ "$FULL" != "1" ] && have swaymsg && have jq; then
    geometry=$(swaymsg -t get_tree \
      | jq -r 'recurse(.nodes[]?,.floating_nodes[]?) | select(.focused) | "\(.rect.x),\(.rect.y) \(.rect.width)x\(.rect.height)"' \
      2>/dev/null || true)
    if [ -n "$geometry" ]; then
      grim -g "$geometry" "$OUT" && captured="grim -g (focused window)"
    fi
  fi
  if [ -z "$captured" ]; then
    grim "$OUT" && captured="grim (whole output)"
  fi
fi

# Plain X11.
if [ -z "$captured" ] && [ "$session" != "wayland" ] && have import; then
  if [ "$FULL" != "1" ] && have xdotool; then
    window=$(xdotool search --class "$APP" 2>/dev/null | head -1 || true)
    if [ -n "$window" ]; then
      import -window "$window" "$OUT" && captured="import -window"
    fi
  fi
  if [ -z "$captured" ]; then
    import -window root "$OUT" && captured="import -window root"
  fi
fi

# xdg-desktop-portal, last resort: no window-tool guessing, works on whatever
# the compositor actually implements (GNOME included, where none of the tools
# above work without KWin/wlroots). --full asks for an immediate capture;
# without it, the portal opens its own picker for the user to click a window
# or region, since there is no portal-level "active window" concept. Either
# way this needs a person at the screen for the permission/picker dialog —
# nothing here can click it for you, so it will not complete in a headless
# session.
#
# This needs a helper (portal-screenshot.gjs) rather than plain gdbus: the
# portal's Response signal goes back only to the exact connection that made
# the Screenshot() call, so a `gdbus call` followed by a separate `gdbus
# monitor` process never sees it — they are two different connections. gjs
# already ships with the desktop shell, so it costs nothing extra here.
portal_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/portal-screenshot.gjs"
if [ -z "$captured" ] && have gjs && [ -f "$portal_helper" ]; then
  interactive=true
  [ "$FULL" = "1" ] && interactive=false

  note "Waiting on the screenshot portal — approve the dialog if one appears (up to 30s)…"
  portal_err="$(mktemp)"
  uri=$(gjs "$portal_helper" "$interactive" 30 2>"$portal_err") || true

  if [ -n "$uri" ]; then
    src="${uri#file://}"
    src="${src//+/ }"
    src="$(printf '%b' "${src//%/\\x}")"
    [ -f "$src" ] && cp "$src" "$OUT" && captured="xdg-desktop-portal"
  fi
  if [ -z "$captured" ]; then
    printf 'warning: portal request did not produce a capture' >&2
    [ -s "$portal_err" ] && printf ' (%s)' "$(cat "$portal_err")" >&2
    printf '.\n' >&2
  fi
  rm -f "$portal_err"
fi

if [ -z "$captured" ]; then
  cat >&2 <<'EOF'
error: no screenshot tool found.

Install whichever suits the desktop:
  GNOME              gnome-screenshot
  KDE                spectacle
  sway / Hyprland    grim  (plus jq for window-only capture)
  X11                imagemagick, and xdotool for window-only capture

gdbus (xdg-desktop-portal) was also tried and did not produce a capture —
either it is not installed, or the portal's dialog was not approved in time.
Run again and watch for the dialog if this is a GNOME/Wayland desktop with
none of the above installed.
EOF
  exit 1
fi

printf 'captured with %s\n' "$captured"
if have identify; then
  identify -format '  %f  %wx%h\n' "$OUT"
else
  ls -lh "$OUT" | awk '{printf "  %s  %s\n", $NF, $5}'
fi
