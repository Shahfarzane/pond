#!/bin/bash
# Rebuilds the app code and repackages it; the app extensions from the first build are reused.
set -euo pipefail
cd "$1"
pnpm build
pnpm exec electron-builder --mac dir --arm64 --publish never
