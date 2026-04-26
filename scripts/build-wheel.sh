#!/usr/bin/env bash
set -euo pipefail

# Build the kibrary_sidecar wheel and copy it into src-tauri/resources/.
# Used by `cargo tauri build` to bundle the wheel for end-user install.
#
# Uses whatever `python` (or `python3`) is on PATH — works in CI without
# a pre-existing venv. For local dev, run from inside the sidecar venv:
#   source sidecar/.venv/bin/activate && bash scripts/build-wheel.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="$ROOT/sidecar"
RESOURCES="$ROOT/src-tauri/resources"

# Resolve a python interpreter
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if command -v python3 >/dev/null 2>&1; then PY=python3
  elif command -v python  >/dev/null 2>&1; then PY=python
  else echo "error: no python on PATH (set PYTHON env var)"; exit 1
  fi
fi

cd "$SIDECAR"
mkdir -p "$RESOURCES"
rm -f "$RESOURCES"/kibrary_sidecar-*.whl

echo "Using Python: $($PY --version 2>&1) ($(command -v $PY))"
"$PY" -m pip install --quiet build
"$PY" -m build --wheel --outdir "$SIDECAR/dist"

# Copy newest wheel
WHEEL=$(ls -t "$SIDECAR/dist"/kibrary_sidecar-*.whl | head -1)
cp "$WHEEL" "$RESOURCES/"
echo "Bundled: $(basename "$WHEEL")"
