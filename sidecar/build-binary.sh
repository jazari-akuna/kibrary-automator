#!/usr/bin/env bash
set -euo pipefail

# Produce a single-file binary of the kibrary_sidecar entry point
# using PyInstaller. The output goes to sidecar/dist/kibrary-sidecar-<triple>
# per Tauri's sidecar naming convention.
#
# Reuses the .build-venv/ created by scripts/build-wheel.sh — both scripts
# work in any order. Creates the venv if absent.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="$ROOT/sidecar"
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
echo "Using Python: $($PY --version 2>&1) ($(command -v $PY))"

# Create or reuse the build venv
if [ ! -d "$VENV" ]; then
  "$PY" -m venv "$VENV"
fi

if [ -x "$VENV/bin/python" ]; then VPY="$VENV/bin/python"
elif [ -x "$VENV/Scripts/python.exe" ]; then VPY="$VENV/Scripts/python.exe"
else echo "error: venv python not found"; exit 1
fi

# Install the sidecar package itself + PyInstaller
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet -e .
"$VPY" -m pip install --quiet pyinstaller

# Tauri sidecar convention: the binary must be named with the target triple
# suffix, e.g. kibrary-sidecar-x86_64-unknown-linux-gnu.
TARGET=$(rustc --version --verbose 2>/dev/null | grep -E '^host:' | awk '{print $2}')
TARGET=${TARGET:-x86_64-unknown-linux-gnu}

OUT_NAME="kibrary-sidecar-${TARGET}"

# Add-data path-separator differs between platforms. Use RELATIVE paths
# (we already cd'd into $SIDECAR) so Git Bash's /d/a/... style paths
# don't confuse PyInstaller on Windows.
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" || "$TARGET" == *windows* ]]; then
  ADDDATA="kibrary_sidecar/data;kibrary_sidecar/data"
else
  ADDDATA="kibrary_sidecar/data:kibrary_sidecar/data"
fi

# --add-data SOURCE paths are resolved relative to --specpath (or cwd
# when --specpath is omitted). We omit --specpath so the spec file
# lands in $SIDECAR (cwd) and the relative kibrary_sidecar/data
# source path resolves correctly. Spec gets cleaned up by --clean.
"$VPY" -m PyInstaller \
  --onefile \
  --name "$OUT_NAME" \
  --add-data "$ADDDATA" \
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
  "kibrary_sidecar/__main__.py"

echo "Bundled binary: $SIDECAR/dist/$OUT_NAME"

# universal-apple-darwin handling: Tauri's --target universal-apple-darwin
# requires BOTH aarch64- and x86_64- variants of the sidecar. PyInstaller
# can't cross-compile, so on macOS arm64 (default GH runner) we duplicate
# the arm64 binary as the x86_64 name. The duplicate runs under Rosetta 2
# on Intel Macs. For a real universal binary, use lipo with two passes.
if [[ "$(uname)" == "Darwin" ]]; then
  case "$TARGET" in
    aarch64-apple-darwin)
      cp "$SIDECAR/dist/$OUT_NAME" "$SIDECAR/dist/kibrary-sidecar-x86_64-apple-darwin"
      echo "Mirrored as: kibrary-sidecar-x86_64-apple-darwin (runs via Rosetta on Intel)"
      ;;
    x86_64-apple-darwin)
      cp "$SIDECAR/dist/$OUT_NAME" "$SIDECAR/dist/kibrary-sidecar-aarch64-apple-darwin"
      echo "Mirrored as: kibrary-sidecar-aarch64-apple-darwin"
      ;;
  esac
fi
