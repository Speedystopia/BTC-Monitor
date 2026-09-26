#!/usr/bin/env bash
# ============================================================================
#  BTC Monitor streamer: the dashboard in Chromium on a virtual screen, sent
#  live to YouTube, Twitch or any RTMP server.
#  The picture and the alert sounds are encoded once; each destination has its
#  own relay, which reconnects by itself (a Twitch broadcast is cut after 48 h,
#  a network drop...) without interrupting the others.
#  Settings: environment variables, see .env.example at the project root.
# ============================================================================
set -uo pipefail

PAGE_URL=${PAGE_URL:-http://btc-monitor:8787/?tf=5m}
WIDTH=${WIDTH:-1920}; HEIGHT=${HEIGHT:-1080}; FPS=${FPS:-30}
VIDEO_BITRATE=${VIDEO_BITRATE:-6000k}; AUDIO_BITRATE=${AUDIO_BITRATE:-128k}
X264_PRESET=${X264_PRESET:-veryfast}
AUDIO=${AUDIO:-1}          # 0: silent audio track instead of the alert sounds
YOUTUBE_URL=${YOUTUBE_URL:-rtmp://a.rtmp.youtube.com/live2}
TWITCH_URL=${TWITCH_URL:-rtmp://live.twitch.tv/app}
DISPLAY_NUM=${DISPLAY_NUM:-99}
export DISPLAY=:$DISPLAY_NUM
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}
PROFILE=/tmp/chromium-profile

log() { echo "$(date -u +%H:%M:%S) [${2:-stream}] $1"; }
fail() { log "$1"; exit 1; }

# ---------------------------------------------------------------- settings check
[[ $WIDTH =~ ^[0-9]+$ && $HEIGHT =~ ^[0-9]+$ && $FPS =~ ^[0-9]+$ ]] || fail "WIDTH, HEIGHT and FPS must be numbers"
[[ $VIDEO_BITRATE =~ ^([0-9]+)k$ ]] || fail "VIDEO_BITRATE must look like 6000k"
BUFSIZE=$(( ${BASH_REMATCH[1]} * 2 ))k
GOP=$(( FPS * 2 ))          # a keyframe every 2 s, as YouTube and Twitch ask

NAMES=(); URLS=()
[ -n "${YOUTUBE_STREAM_KEY:-}" ] && { NAMES+=(youtube); URLS+=("$YOUTUBE_URL/$YOUTUBE_STREAM_KEY"); }
[ -n "${TWITCH_STREAM_KEY:-}" ] && { NAMES+=(twitch); URLS+=("$TWITCH_URL/$TWITCH_STREAM_KEY"); }
n=0; for u in ${RTMP_URLS:-}; do n=$((n + 1)); NAMES+=("rtmp-$n"); URLS+=("$u"); done
[ ${#URLS[@]} -gt 0 ] || fail "no destination: set YOUTUBE_STREAM_KEY, TWITCH_STREAM_KEY or RTMP_URLS"

CHROME_BIN=${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}
[ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ] || fail "Chromium not found (set CHROME_BIN)"

stop() { trap - TERM INT; log "stopping"; kill $(jobs -p) 2>/dev/null; exit 0; }
trap stop TERM INT

# ---------------------------------------------------------------- virtual screen + sound card
rm -f "/tmp/.X$DISPLAY_NUM-lock"
Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp -dpi 96 >/dev/null 2>&1 &
XVFB=$!
for _ in $(seq 100); do [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] && break; sleep 0.1; done
[ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] || fail "the virtual screen did not start"

AUDIO_IN=(-f lavfi -thread_queue_size 1024 -i anullsrc=channel_layout=stereo:sample_rate=44100)
if [ "$AUDIO" = 1 ]; then
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  if pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr -n \
       --load="module-native-protocol-unix" \
       --load="module-null-sink sink_name=stream sink_properties=device.description=BTC-Monitor" >/dev/null 2>&1 \
     && pactl set-default-sink stream; then
    AUDIO_IN=(-f pulse -thread_queue_size 1024 -i stream.monitor)
  else
    log "no sound server: the stream gets a silent audio track"
  fi
fi

# ---------------------------------------------------------------- browser
log "waiting for the dashboard: $PAGE_URL"
until curl -fsS -o /dev/null --max-time 10 "$PAGE_URL"; do sleep 3; done

browser() {
  while true; do
    rm -rf "$PROFILE"   # fresh profile: no "restore pages" bubble after a crash
    # --no-sandbox: Chromium's sandbox needs privileges a container does not have (the page is the local dashboard)
    "$CHROME_BIN" --kiosk --window-position=0,0 --window-size="$WIDTH,$HEIGHT" --force-device-scale-factor=1 \
      --user-data-dir="$PROFILE" --no-sandbox --test-type --no-first-run --no-default-browser-check \
      --disable-infobars --noerrdialogs --disable-session-crashed-bubble --disable-dev-shm-usage \
      --autoplay-policy=no-user-gesture-required --password-store=basic --hide-scrollbars --lang=en-US \
      --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
      --disable-features=Translate,MediaRouter --disable-component-update --disable-sync \
      "$PAGE_URL" >/dev/null 2>&1 &
    local pid=$! corner="x:$((WIDTH - 1)) y:$((HEIGHT - 1)) "
    # the mouse rests in a corner: over the chart it would draw the crosshair on the stream
    # (Xvfb only moves it once the browser window is there)
    for _ in $(seq 60); do
      kill -0 "$pid" 2>/dev/null || break
      xdotool mousemove $((WIDTH - 1)) $((HEIGHT - 1)) 2>/dev/null
      [[ $(xdotool getmouselocation 2>/dev/null) == "$corner"* ]] && break
      sleep 0.5
    done
    wait "$pid"
    log "Chromium stopped (code $?), restarting"
    sleep 3
  done
}
browser &
sleep 5   # let the page draw before the first frames go out

# ---------------------------------------------------------------- encoder (once) -> one local UDP feed per destination
encoder() {
  local out="" i
  for i in "${!URLS[@]}"; do out+="${out:+|}[f=mpegts:onfail=ignore]udp://127.0.0.1:$((5000 + i))?pkt_size=1316"; done
  while true; do
    log "encoding ${WIDTH}x${HEIGHT} ${FPS} fps, ${VIDEO_BITRATE}, to ${NAMES[*]}"
    ffmpeg -hide_banner -nostats -loglevel warning \
      -f x11grab -draw_mouse 0 -thread_queue_size 1024 -video_size "${WIDTH}x${HEIGHT}" -framerate "$FPS" -i "$DISPLAY" \
      "${AUDIO_IN[@]}" -map 0:v -map 1:a \
      -c:v libx264 -preset "$X264_PRESET" -pix_fmt yuv420p -b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_BITRATE" -bufsize "$BUFSIZE" \
      -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
      -c:a aac -b:a "$AUDIO_BITRATE" -ar 44100 -ac 2 \
      -f tee "$out" 2>&1 | while IFS= read -r line; do
        case $line in *"not enough frames to estimate rate"*|*"Guessed Channel Layout"*) continue ;; esac  # harmless, at start
        log "$line" encoder
      done
    log "encoder stopped (code ${PIPESTATUS[0]}), restarting in 5 s" encoder
    sleep 5
  done
}

# ---------------------------------------------------------------- relays: local feed -> RTMP server, reconnecting
relay() {
  local name=$1 url=$2 port=$3 wait=5 started code pid key=${2##*/}
  while true; do
    started=$(date +%s)
    log "connecting" "$name"
    ffmpeg -hide_banner -nostats -loglevel error \
      -i "udp://127.0.0.1:$port?fifo_size=50000&overrun_nonfatal=1&timeout=15000000" \
      -map 0 -c copy -rw_timeout 15000000 -f flv "$url" 2>&1 \
      | while IFS= read -r line; do
          case $line in *"[h264 @"*|*"Last message repeated"*) continue ;; esac  # joining the feed between two keyframes
          line=${line//"$url"/<$name>}; [ ${#key} -ge 6 ] && line=${line//"$key"/****}  # the stream key never reaches the logs
          log "$line" "$name"
        done &
    pid=$!
    { sleep 20; kill -0 "$pid" 2>/dev/null && log "on air" "$name"; } &
    wait "$pid"; code=$?
    # quick failures (wrong key, platform down) wait longer and longer, up to 5 minutes; after a long run, 5 s
    if [ $(( $(date +%s) - started )) -gt 120 ]; then wait=5; else wait=$(( wait * 2 > 300 ? 300 : wait * 2 )); fi
    log "disconnected (code $code), next attempt in ${wait} s" "$name"
    sleep "$wait"
  done
}

for i in "${!URLS[@]}"; do relay "${NAMES[$i]}" "${URLS[$i]}" $((5000 + i)) & done
encoder &

wait "$XVFB"
fail "the virtual screen stopped"
