#!/bin/bash
# Launches the test build against an isolated data folder and a mock keychain.
# Usage: launch-test-app.sh <path to .app> <sandbox dir>
set -euo pipefail
app="$1"
sandbox="$2"
mkdir -p "$sandbox"
name="$(basename "$app" .app)"
exec env POND_SANDBOX="$sandbox" "$app/Contents/MacOS/$name" --use-mock-keychain "${@:3}"
