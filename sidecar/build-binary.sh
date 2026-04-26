#!/usr/bin/env bash
set -euo pipefail

# Produce a single-file binary of the kibrary_sidecar entry point
# using PyInstaller. The output goes to sidecar/dist/kibrary-sidecar-<triple>
# per Tauri's sidecar naming convention.
#
# Uses whatever `python` (or `python3`) is on PATH — works in CI without a
# pre-existing venv. For local dev, run from inside the sidecar venv:
#   source sidecar/.venv/bin/activate && bash sidecar/build-binary.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="$ROOT/sidecar"

# Resolve a python interpreter
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if command -v python3 >/dev/null 2>&1; then PY=python3
  elif command -v python  >/dev/null 2>&1; then PY=python
  else echo "error: no python on PATH (set PYTHON env var)"; exit 1
  fi
fi

cd "$SIDECAR"
echo "Using Python: $($PY --version 2>&1) ($(command -v $PY))"

# Install the sidecar package itself (so PyInstaller can find kibrary_sidecar
# and its data files via the installed metadata) plus pyinstaller.
"$PY" -m pip install --quiet -e .
"$PY" -m pip install --quiet pyinstaller

# Tauri sidecar convention: the binary must be named with the target triple
# suffix, e.g. kibrary-sidecar-x86_64-unknown-linux-gnu.
TARGET=$(rustc --version --verbose 2>/dev/null | grep -E '^host:' | awk '{print $2}')
TARGET=${TARGET:-x86_64-unknown-linux-gnu}

OUT_NAME="kibrary-sidecar-${TARGET}"

"$PY" -m PyInstaller \
  --onefile \
  --name "$OUT_NAME" \
  --add-data "$SIDECAR/kibrary_sidecar/data:kibrary_sidecar/data" \
  --hidden-import=kiutils.symbol \
  --hidden-import=kiutils.footprint \
  --hidden-import=keyring.backends \
  --hidden-import=secretstorage \
  --hidden-import=respx \
  --collect-all kiutils \
  --collect-all JLC2KiCadLib \
  --noconfirm \
  --clean \
  --distpath "$SIDECAR/dist" \
  --workpath "$SIDECAR/build" \
  --specpath "$SIDECAR/build" \
  "$SIDECAR/kibrary_sidecar/__main__.py"

echo "Bundled: $SIDECAR/dist/$OUT_NAME"
