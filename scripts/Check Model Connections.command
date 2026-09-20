#!/bin/bash
# Reports which model routes actually answer. Owner: Akshay Dubey.
cd "$HOME/Documents/agent-command-center" || { echo "Project folder not found."; read -r; exit 1; }
clear
if [ ! -f .env ]; then
  echo "No .env file yet."
  echo
  echo "Copy .env.example to .env and fill in:"
  echo "  LLM_GATEWAY_URL, LLM_GATEWAY_API_KEY"
  echo "  MODEL_OPENAI, MODEL_CLAUDE, MODEL_GEMINI, MODEL_PERPLEXITY"
  echo
  echo "Until then the app runs its routing preview and calls no provider."
  echo; echo "Press return to close."; read -r; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
npm run doctor
echo; echo "Press return to close."; read -r
