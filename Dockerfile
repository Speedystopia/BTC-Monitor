# ============================================================================
#  BTC Monitor: dashboard server image (Node 24 LTS)
#    docker build -t btc-monitor .
#    docker run -d --name btc-monitor -p 127.0.0.1:8787:8787 -v btcm-data:/app/data btc-monitor
#  Your own settings: mount a config.js on /app/config.js (read-only is fine).
#  docker-compose.yml runs it with HTTPS (Caddy) and the YouTube / Twitch streamer.
# ============================================================================
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY config.js ./
COPY core ./core
COPY server ./server
COPY public ./public
COPY data/icons ./data/icons
# data/: liquidation and heatmap stores, downloaded logos (a volume keeps them across updates)
RUN chown -R node:node /app/data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD wget -qO /dev/null http://127.0.0.1:8787/api/health || exit 1
# 0.0.0.0: reachable through the published port and from the other containers (config.js `host` is for a PC)
CMD ["node", "server/index.js", "--host", "0.0.0.0"]
