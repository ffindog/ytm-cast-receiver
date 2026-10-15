#!/bin/sh
# Screen supervisor. Runs Cog (WPE WebKit, DRM platform) on the DRM card(s)
# passed into the container, showing the ytcr now-playing page,
# and hands the screen to ytcr while a video plays: only one program can
# drive the screen. ytcr says which via /api/now-playing "mode"; this script
# closes Cog and confirms with POST /api/screen-released, then reopens Cog
# once the mode has been back to "audio" for a moment.
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
# Runs as root in a container with no user namespaces for WebKit's sandbox.
# It only ever loads the local now-playing / dashboard pages.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
URL="${KIOSK_URL:-http://127.0.0.1:8098/}"
API="${KIOSK_API:-http://127.0.0.1:8098}"
COG=""
AUDIO_SINCE=""

cog_running() { [ -n "$COG" ] && kill -0 "$COG" 2>/dev/null; }
# TV off or in standby shows as "disconnected"; Cog will not start then.
screen_connected() { grep -qx connected /sys/class/drm/card*-*/status 2>/dev/null; }
mode() { curl -sf --max-time 2 "$API/api/now-playing" | grep -o '"mode":"[a-z]*"' | cut -d'"' -f4; }

stop_cog() {
  if cog_running; then
    kill "$COG" 2>/dev/null
    i=0
    while cog_running && [ $i -lt 30 ]; do i=$((i+1)); sleep 0.1; done
    cog_running && kill -9 "$COG" 2>/dev/null
    wait "$COG" 2>/dev/null
  fi
  COG=""
}

trap 'stop_cog; exit 0' TERM INT

while :; do
  m=$(mode)
  if [ "$m" = "video" ]; then
    AUDIO_SINCE=""
    stop_cog
    curl -sf --max-time 2 -X POST "$API/api/screen-released" >/dev/null 2>&1
  elif [ -n "$m" ]; then
    # Back to audio (or idle): wait 2 s in case the next item is a video too.
    now=$(date +%s)
    [ -z "$AUDIO_SINCE" ] && AUDIO_SINCE=$now
    if ! cog_running && [ $((now - AUDIO_SINCE)) -ge 2 ] && screen_connected; then
      cog --platform=drm "$URL" &
      COG=$!
    fi
  fi
  sleep 0.5
done
