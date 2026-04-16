#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/openai/codex"
TMP_DIR="${TMPDIR:-/tmp}/codex-schema-sync-$$"
TARGET_DIR="src/vendor/codex-app-server-protocol"
SOURCE_PATH="codex-rs/app-server-protocol/schema/typescript"

rm -rf "$TMP_DIR"
git clone --depth=1 "$REPO_URL" "$TMP_DIR"
COMMIT_SHA="$(git -C "$TMP_DIR" rev-parse HEAD)"

rm -rf "$TARGET_DIR"
mkdir -p "$(dirname "$TARGET_DIR")"
cp -R "$TMP_DIR/$SOURCE_PATH" "$TARGET_DIR"

cat > src/vendor/codex-schema-source.md <<MARKDOWN
# Codex App Server Protocol Schema Source

Vendored from:
- repo: \\`$REPO_URL\\`
- path: \\`$SOURCE_PATH\\`
- commit: \\`$COMMIT_SHA\\`
- synced at: \\`$(date +%F)\\`

Update by running:

\\`\\`\\`bash
scripts/sync-codex-schema-types.sh
\\`\\`\\`
MARKDOWN

rm -rf "$TMP_DIR"
echo "Synced Codex schema types at commit: $COMMIT_SHA"
