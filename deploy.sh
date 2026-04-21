#!/usr/bin/env bash
# deploy.sh — Build everything and deploy to Firebase
# Usage: bash deploy.sh
set -e

FLUTTER_APP="../../flutter/gym_fitness_app"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "=== 1. Building Flutter web ==="
cd "$FLUTTER_APP"
flutter build web --release --no-wasm-dry-run
echo "    Done."

echo "=== 2. Copying web build to public/ ==="
rm -rf "$REPO_ROOT/public"
mkdir -p "$REPO_ROOT/public"
cp -r build/web/. "$REPO_ROOT/public/"
echo "    Done."

echo "=== 3. Building backend ==="
cd "$REPO_ROOT/backend"
npm run build
echo "    Done."

echo "=== 4. Deploying to Firebase ==="
cd "$REPO_ROOT"
firebase deploy
echo ""
echo "✓ Deployment complete!"
