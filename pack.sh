#!/usr/bin/env bash
# Pack files required to run HaxPaintball. No IDE metadata, agent cache, or build output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

OUT_DIR="${1:-dist}"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="haxpaintball-${STAMP}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/haxpaintball-pack.XXXXXX")"
ARCHIVE="$ROOT/$OUT_DIR/$NAME.zip"

cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT

INCLUDE_FILES=(
  package.json
  package-lock.json
  README.md
  .dockerignore
  docker-compose.yml
  Dockerfile
)

INCLUDE_DIRS=(
  client
  server
  shared
  maps
)

for path in "${INCLUDE_FILES[@]}" "${INCLUDE_DIRS[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "Brakuje $path — paczka nie wystartuje bez tego pliku." >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR" "$STAGE/$NAME"

for path in "${INCLUDE_FILES[@]}"; do
  cp "$path" "$STAGE/$NAME/"
done

# Copy runtime trees only. Explicit includes keep .proxyai, .idea, dist, and PLAN.md out.
for dir in "${INCLUDE_DIRS[@]}"; do
  mkdir -p "$STAGE/$NAME/$dir"
  rsync -a \
    --exclude '.DS_Store' \
    --exclude '*.log' \
    "$dir/" "$STAGE/$NAME/$dir/"
done

(
  cd "$STAGE"
  zip -r -q -X "$ARCHIVE" "$NAME"
)

echo "Spakowano: $OUT_DIR/$NAME.zip"
echo "Start po rozpakowaniu: node server/index.js"
echo "Potem otwórz http://localhost:8080"
