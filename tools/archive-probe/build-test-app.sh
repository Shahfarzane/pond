#!/bin/bash
# Builds an unpacked, Developer ID signed arm64 Pond from the given apps/desktop folder.
# Notarization is skipped: APPLE_ID and friends are not set.
set -euo pipefail
cd "$1"
pnpm build
node ./scripts/build-apple-model.mjs
node ./scripts/build-native-host.mjs
node ./scripts/build-safari-extension.mjs
node ./scripts/build-share-extension.mjs
pnpm exec electron-builder --mac dir --arm64 --publish never
