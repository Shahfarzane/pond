#!/bin/bash
# Notarizes and staples a signed .app. Credentials come from 1Password via op-agents and are never printed.
# Usage: NOTARY_OP_ITEM=<1Password item id> notarize-app.sh <path to .app> <work dir>
# The item needs the fields `username` (Apple ID), `password` (app-specific password) and `Team ID`.
set -euo pipefail
app="$1"
work="$2"
item="${NOTARY_OP_ITEM:?set NOTARY_OP_ITEM to the 1Password item id holding the notarization credentials}"
mkdir -p "$work"
zip="$work/$(basename "$app" .app).zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
apple_id="$(op-agents read "op://DEV/$item/username")"
password="$(op-agents read "op://DEV/$item/password")"
team="$(op-agents read "op://DEV/$item/Team ID")"
xcrun notarytool submit "$zip" --apple-id "$apple_id" --password "$password" --team-id "$team" --wait
xcrun stapler staple "$app"
rm -f "$zip"
spctl -a -vv -t exec "$app"
