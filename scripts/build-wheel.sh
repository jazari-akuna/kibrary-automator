#!/usr/bin/env bash
set -euo pipefail

# Build the kibrary_sidecar wheel and copy it into src-tauri/resources/.
# Used by `cargo tauri build` to bundle the wheel for end-user install.
#
# Creates an isolated venv at sidecar/.build-venv/ and installs `build`
# into it — avoids PEP 668 errors on macOS / newer Linux distros where
# the system python is "externally managed".

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="$ROOT/sidecar"
RESOURCES="$ROOT/src-tauri/resources"
VENV="$SIDECAR/.build-venv"

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

# Create or reuse an isolated build venv
if [ ! -d "$VENV" ]; then
  "$PY" -m venv "$VENV"
fi

# Resolve venv python (Unix vs Windows)
if [ -x "$VENV/bin/python" ]; then VPY="$VENV/bin/python"
elif [ -x "$VENV/Scripts/python.exe" ]; then VPY="$VENV/Scripts/python.exe"
else echo "error: venv python not found"; exit 1
fi

"$VPY" -m pip install --quiet --upgrade pip build
"$VPY" -m build --wheel --outdir "$SIDECAR/dist"

# Copy newest wheel
WHEEL=$(ls -t "$SIDECAR/dist"/kibrary_sidecar-*.whl | head -1)
cp "$WHEEL" "$RESOURCES/"
echo "Bundled wheel: $(basename "$WHEEL")"
