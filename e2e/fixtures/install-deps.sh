#!/usr/bin/env bash
# Install Python deps for fixture generation.
#
# Cost note: cadquery + pinned OCP wheel is ~80-110 MB on disk (mostly
# OpenCascade native libs). We isolate it inside a venv at
# e2e/fixtures/.venv to avoid polluting the system / sidecar envs.
#
# Usage:
#   bash e2e/fixtures/install-deps.sh
#   source e2e/fixtures/.venv/bin/activate
#   python3 e2e/fixtures/synthetic_pcb_named/gen_step.py
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${HERE}/.venv"

if [[ ! -d "${VENV}" ]]; then
  echo "[install-deps] creating venv at ${VENV}"
  python3 -m venv "${VENV}"
fi

# shellcheck disable=SC1091
source "${VENV}/bin/activate"

python3 -m pip install --upgrade pip >/dev/null

# Pin to the latest stable cadquery; let pip resolve a compatible OCP wheel.
# cadquery 2.4.0 is the last formal release as of writing, but newer point
# releases work the same for STEP export.
# Pin numpy<2 because cadquery 2.4.0 pulls in nptyping 2.0.1 which still
# uses removed numpy aliases (np.bool8). Without this pin the import
# fails on numpy>=2.
python3 -m pip install "numpy<2" "cadquery==2.4.0"

python3 -c "import cadquery; print('[install-deps] cadquery', cadquery.__version__, 'OK')"
