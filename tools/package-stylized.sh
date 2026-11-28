#!/usr/bin/env bash
# Builds the local experimental Stylized Canvas module archive. No publishing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/module.json').version")"
# Keep this in lockstep with module.json's download URL (Journalinator-v<version>.zip).
NAME="Journalinator-v$VERSION"
OUT="$ROOT/dist"
MODULE_DIR="$OUT/fvtt-journalinator"

rm -rf "$MODULE_DIR" "$OUT/$NAME.zip"
mkdir -p "$MODULE_DIR"

cp "$ROOT/module.json" "$ROOT/LICENSE" "$MODULE_DIR/"
cp "$ROOT/README.md" "$ROOT/CHANGELOG.md" "$MODULE_DIR/"
cp -a "$ROOT/docs" "$MODULE_DIR/"
cp -a "$ROOT/scripts" "$ROOT/styles" "$ROOT/lang" "$ROOT/assets" "$MODULE_DIR/"

# Never ship design references, tests, source maps, node_modules, or the stale legacy dist.
find "$MODULE_DIR" -name '*.map' -delete
( cd "$OUT" && zip -qr "$NAME.zip" fvtt-journalinator )
( cd "$OUT" && sha256sum "$NAME.zip" > "$NAME.zip.sha256" )

echo "Built $OUT/$NAME.zip"
echo "SHA-256: $(cut -d' ' -f1 "$OUT/$NAME.zip.sha256") ($OUT/$NAME.zip.sha256)"
unzip -l "$OUT/$NAME.zip" | tail -n 5
