#!/bin/bash
# Types, lint, 97 unit tests, build, 53 end-to-end checks. Owner: Akshay Dubey.
cd "$HOME/Documents/agent-command-center" || { echo "Project folder not found."; read -r; exit 1; }
clear
[ -d node_modules ] || npm install --no-audit --no-fund
npm run verify:all
echo; echo "Press return to close."; read -r
