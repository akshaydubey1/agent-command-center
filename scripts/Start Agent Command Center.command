#!/bin/bash
# Agent Command Center — one-click launcher. Owner: Akshay Dubey.
cd "$HOME/Documents/agent-command-center" || { echo "Project folder not found."; read -r; exit 1; }
clear
echo "================================================"
echo "  Agent Command Center"
echo "  Owner: Akshay Dubey"
echo "================================================"
echo

hold() { echo; echo "Press return to close this window."; read -r; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install the LTS build from https://nodejs.org (version 22.13 or newer), then run this again."
  hold; exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 22 ]; then
  echo "Node.js $(node -v) is too old. This project needs 22.13 or newer."
  hold; exit 1
fi
echo "Node.js $(node -v)"
echo

if [ ! -d node_modules ]; then
  echo "[1/4] Installing dependencies (first run only, a few minutes)..."
  npm install --no-audit --no-fund || { echo; echo "Install failed. The output above says why."; hold; exit 1; }
else
  echo "[1/4] Dependencies already installed."
fi

echo
echo "[2/4] Building..."
npm run build >/tmp/acc-build.log 2>&1 || { echo "Build failed. See /tmp/acc-build.log"; hold; exit 1; }

if [ ! -d .wrangler/state ]; then
  echo "[3/4] Creating the local run-history database..."
  node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB \
    --local --config dist/server/wrangler.json --persist-to .wrangler/state \
    --file drizzle/0000_command_center.sql >/tmp/acc-db.log 2>&1 \
    && echo "      run history is durable." || echo "      skipped; history stays in the browser."
else
  echo "[3/4] Run-history database already exists."
fi

echo
echo "[4/4] Starting the server..."
npm run dev -- --port 5173 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT

for _ in $(seq 1 90); do
  curl -s -o /dev/null http://localhost:5173/ && break
  sleep 2
done

open "http://localhost:5173"
echo
echo "================================================"
echo "  Running at http://localhost:5173"
echo "  Press Control-C here to stop the server."
echo "================================================"
wait $DEV_PID
