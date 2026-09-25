# ============================================================================
#  BTC Monitor streamer image: Chromium shows the dashboard on a virtual screen
#  (Xvfb), ffmpeg sends it with the alert sounds (PulseAudio) to YouTube, Twitch
#  or any RTMP server. Started by docker-compose.yml (--profile stream).
#    docker build -t btc-monitor-streamer deploy/stream
# ============================================================================
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb xdotool pulseaudio pulseaudio-utils ffmpeg \
      fonts-noto-color-emoji fonts-liberation2 fonts-dejavu-core curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 streamer \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
COPY stream.sh /usr/local/bin/stream.sh
RUN chmod 755 /usr/local/bin/stream.sh

USER streamer
WORKDIR /home/streamer
# tini -g: a stop signal reaches Chromium and ffmpeg too
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/stream.sh"]
