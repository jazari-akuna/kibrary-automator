#!/usr/bin/env bash
set -euo pipefail

# Produce a single-file binary of the kibrary_sidecar entry point
# using PyInstaller. The output goes to sidecar/dist/kibrary-sidecar
# (named platform-specifically by Tauri's sidecar convention).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="$ROOT/sidecar"

cd "$SIDECAR"
.venv/bin/pip install --quiet pyinstaller

# Tauri sidecar convention: the binary must be named with the target triple
# suffix, e.g. kibrary-sidecar-x86_64-unknown-linux-gnu.
TARGET=$(rustc --version --verbose 2>/dev/null | grep -E '^host:' | awk '{print $2}')
TARGET=${TARGET:-x86_64-unknown-linux-gnu}

OUT_NAME="kibrary-sidecar-${TARGET}"

.venv/bin/pyinstaller \
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
