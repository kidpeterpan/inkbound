#!/usr/bin/env bash
set -euo pipefail
VAULT="${VAULT:-~/Documents/pan_vault}"
DEST="$VAULT/.obsidian/plugins/epub-export"
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "Deployed to $DEST"
