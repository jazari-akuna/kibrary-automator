#!/usr/bin/env bash
set -euo pipefail

# Build the kibrary_sidecar wheel and copy it into src-tauri/resources/.
# Used by `cargo tauri build` to bundle the wheel for end-user install.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="$ROOT/sidecar"
RESOURCES="$ROOT/src-tauri/resources"

cd "$SIDECAR"
mkdir -p "$RESOURCES"
rm -f "$RESOURCES"/kibrary_sidecar-*.whl

# Build wheel
.venv/bin/pip install --quiet build
.venv/bin/python -m build --wheel --outdir "$SIDECAR/dist"

# Copy newest wheel
WHEEL=$(ls -t "$SIDECAR/dist"/kibrary_sidecar-*.whl | head -1)
cp "$WHEEL" "$RESOURCES/"
echo "Bundled: $(basename "$WHEEL")"
