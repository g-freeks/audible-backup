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

if [ -z "$captured" ]; then
  cat >&2 <<'EOF'
error: no screenshot tool found.

Install whichever suits the desktop:
  GNOME              gnome-screenshot
  KDE                spectacle
  sway / Hyprland    grim  (plus jq for window-only capture)
  X11                imagemagick, and xdotool for window-only capture
EOF
  exit 1
fi

printf 'captured with %s\n' "$captured"
if have identify; then
  identify -format '  %f  %wx%h\n' "$OUT"
else
  ls -lh "$OUT" | awk '{printf "  %s  %s\n", $NF, $5}'
fi
