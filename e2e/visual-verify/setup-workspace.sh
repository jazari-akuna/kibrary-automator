#!/usr/bin/env bash
#
# setup-workspace.sh — build a kibrary workspace from the visual-verify
# fixtures in e2e/fixtures/. Each fixture directory becomes a KSL-shaped
# library inside ${VISUAL_VERIFY_WORKSPACE} (default /tmp/visual-verify-workspace):
#
#   <ws>/<lib>/<lib>.kicad_sym       (minimal symbol so list_libraries finds it)
#   <ws>/<lib>/<lib>.pretty/<fp>.kicad_mod   (rewritten so model path → ${KSL_ROOT}/<lib>/...)
#   <ws>/<lib>/<lib>.3dshapes/<fp>.{step,STEP}
#
# Idempotent: wipes and rebuilds the workspace on every run so a
# previous run's stale artefacts can't influence the harness.
#
# Env: VISUAL_VERIFY_WORKSPACE (output dir)
#      VISUAL_VERIFY_FIXTURES_SRC (override fixtures source dir, used by Docker run)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
WORKSPACE="${VISUAL_VERIFY_WORKSPACE:-/tmp/visual-verify-workspace}"
FIXTURES_SRC="${VISUAL_VERIFY_FIXTURES_SRC:-${REPO_ROOT}/e2e/fixtures}"

echo "==> setup-workspace: WORKSPACE=${WORKSPACE} SRC=${FIXTURES_SRC}"

if [ ! -d "$FIXTURES_SRC" ]; then
  echo "❌ fixtures source missing: $FIXTURES_SRC" >&2
  exit 1
fi

rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"

# Mapping: <fixture-subdir-in-src> <lib-name> <kicad_mod-basename> <step-basename>
# (basenames include extension so we can preserve .step vs .STEP exactly.)
MAPPINGS=(
  "u_fl_hirose|UFL_KSL|U.FL_Hirose_U.FL-R-SMT-1_Vertical.kicad_mod|U.FL_Hirose_U.FL-R-SMT-1_Vertical.step"
  "usb_c_hro|USBC_KSL|USB_C_Receptacle_HRO_TYPE-C-31-M-12.kicad_mod|USB_C_Receptacle_HRO_TYPE-C-31-M-12.STEP"
  "synthetic_pcb_named|SyntheticPCB_KSL|synthetic_pcb_named.kicad_mod|synthetic_pcb_named.step"
)

for entry in "${MAPPINGS[@]}"; do
  IFS='|' read -r src_dir lib_name fp_file step_file <<<"$entry"
  src="$FIXTURES_SRC/$src_dir"
  if [ ! -f "$src/$fp_file" ] || [ ! -f "$src/$step_file" ]; then
    echo "❌ missing inputs for $lib_name in $src" >&2
    ls -la "$src" >&2 || true
    exit 1
  fi

  lib_dir="$WORKSPACE/$lib_name"
  pretty_dir="$lib_dir/${lib_name}.pretty"
  shapes_dir="$lib_dir/${lib_name}.3dshapes"
  mkdir -p "$pretty_dir" "$shapes_dir"

  # Footprint name (matches the symbol's entryName + (footprint "X") header).
  fp_stem="${fp_file%.kicad_mod}"

  # 1. Copy STEP verbatim (preserve case/extension).
  cp "$src/$step_file" "$shapes_dir/$step_file"

  # 2. Rewrite the .kicad_mod's (model …) path to point at THIS lib's
  #    .3dshapes/. Wave 1-B left them all referencing ${KSL_ROOT}/UFL_KSL/...
  #    even for the USB-C and synthetic fixtures.
  python3 - <<PY
import re, pathlib, sys
src = pathlib.Path("$src/$fp_file").read_text(encoding="utf-8")
# Match a (model "PATH" or (model PATH at the start of the model block.
new_path = "\${KSL_ROOT}/$lib_name/${lib_name}.3dshapes/$step_file"
def _rewrite(m):
    quote = m.group(1) or ""
    return f'(model {quote}{new_path}{quote}'
out = re.sub(
    r'\(model\s+(["\']?)[^"\')\s]+\1',
    _rewrite,
    src,
    count=1,
)
pathlib.Path("$pretty_dir/$fp_file").write_text(out, encoding="utf-8")
PY

  # 3. Generate a minimal .kicad_sym with one entry whose name == fp_stem
  #    (so __kibraryTest.selectComponent(<fp_stem>) finds it). The symbol
  #    Footprint property points at <lib>:<fp_stem>; lib_scanner uses that
  #    when resolving the kicad_mod for a component.
  cat > "$lib_dir/${lib_name}.kicad_sym" <<KSYM
(kicad_symbol_lib (version 20211014) (generator kibrary-fixture)
  (symbol "${fp_stem}" (in_bom yes) (on_board yes)
    (property "Reference" "U" (id 0) (at 0.0 0.0 0))
    (property "Value" "${fp_stem}" (id 1) (at 0.0 0.0 0))
    (property "Footprint" "${lib_name}:${fp_stem}" (id 2) (at 0.0 0.0 0))
    (property "Datasheet" "" (id 3) (at 0.0 0.0 0))
  )
)
KSYM

  echo "  built ${lib_name}/  (fp=${fp_stem}, step=${step_file})"
done

# Sanity: directory tree the harness will see.
echo "==> workspace tree:"
find "$WORKSPACE" -maxdepth 3 -mindepth 1 | sort | sed 's/^/  /'

# Quick spot-check of a rewritten model line.
for lib in UFL_KSL USBC_KSL SyntheticPCB_KSL; do
  fp=$(ls "$WORKSPACE/$lib/${lib}.pretty/"*.kicad_mod | head -1)
  echo "==> ${lib} model line:"
  grep -n "(model " "$fp" | sed 's/^/    /'
done

echo "==> setup-workspace done."
