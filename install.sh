#!/usr/bin/env sh
# Usage: curl -fsSL https://raw.githubusercontent.com/minKasent/chronos-dev/main/install.sh | sh
set -e

echo "⏱  Installing chronos-dev (Flight Recorder & Code Time Machine)..."

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ Node.js / npm is required. Install Node.js (>=18) from https://nodejs.org"
  exit 1
fi

if [ -f "./package.json" ] && grep -q '"name": "chronos-dev"' ./package.json 2>/dev/null; then
  echo "📦 Linking local chronos-dev package globally..."
  npm link
else
  echo "📦 Installing chronos-dev globally from GitHub (minKasent/chronos-dev)..."
  npm install -g github:minKasent/chronos-dev
fi

echo ""
echo "✅ Installed successfully! You can now use 'chronos' or the fast alias 'ch' anywhere:"
echo "   ch r <cmd>    -> Run command & snapshot code (e.g. ch r npm test)"
echo "   ch d          -> Diff current code against --last-green"
echo "   ch back       -> Rewind workspace to --last-green"
echo "   ch ui --open  -> Open Web Flight Recorder Dashboard"
