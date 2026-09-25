#!/bin/bash
# BTC Monitor - lancement (macOS / Linux). Double-clic possible sur start.command (macOS).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js est requis : https://nodejs.org"; read -r -p "Entree pour fermer"; exit 1
fi
[ -d node_modules/ws ] || npm install --no-audit --no-fund
node server/index.js --open "$@"
