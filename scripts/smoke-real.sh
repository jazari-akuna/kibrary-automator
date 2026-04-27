#!/usr/bin/env bash
#
# smoke-real.sh — exercise EVERY user-facing RPC against the real bundled
# sidecar binary, with real kicad-cli, against the real JLCPCB network.
#
# Runs inside Dockerfile.smoke-real. Exits 0 on success, non-zero with a
# clear error message on failure. Designed to catch the bugs that mocked
# unit tests never could: file-layout mismatches, kicad-cli flag changes,
# JLC2KiCadLib quirks per real footprint, et cetera.
#
# Released-blocking: scripts/release.sh runs this on the freshly-built
# .deb before publishing the GitHub release. Any failure here aborts the
# release.
#
set -euo pipefail

STAGING=/tmp/smoke-real-staging
rm -rf "$STAGING"
mkdir -p "$STAGING"

SIDECAR=/usr/local/bin/kibrary-sidecar

# Parts to exercise — chosen for footprint diversity:
#   C25804  — passive (resistor 0603) — simple
#   C193707 — IC with LGA-48 footprint (long name, dots, dashes)
PARTS='["C25804","C193707"]'

echo "==> Sanity: kicad-cli + sidecar binary are installed"
which kicad-cli || { echo "❌ kicad-cli missing"; exit 1; }
kicad-cli --version | head -1
"$SIDECAR" </dev/null >/dev/null 2>&1 || true   # warm Python startup
echo

echo "==> RPC: parts.download (real network → real JLC2KiCadLib → real icon render)"
RES="$(echo "{\"id\":1,\"method\":\"parts.download\",\"params\":{\"lcscs\":${PARTS},\"staging_dir\":\"${STAGING}\",\"concurrency\":2}}" \
  | timeout 120 "$SIDECAR" 2>/dev/null \
  | grep -E '^\{"id":1' | head -1)"
echo "  response: $RES"
OK="$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok', False))")"
if [ "$OK" != "True" ]; then
  echo "❌ parts.download did not return ok=true"
  exit 1
fi
echo

echo "==> File layout per part"
for L in C25804 C193707; do
  echo "  --- $L ---"
  SYM="$STAGING/$L/$L.kicad_sym"
  PRETTY_DIR="$STAGING/$L/$L.pretty"
  SHAPES_DIR="$STAGING/$L/$L.3dshapes"
  ICON="$STAGING/$L/$L.icon.svg"

  [ -f "$SYM" ]            || { echo "    ❌ missing $SYM"; exit 1; }
  [ -d "$PRETTY_DIR" ]     || { echo "    ❌ missing $PRETTY_DIR"; exit 1; }
  [ -d "$SHAPES_DIR" ]     || { echo "    ❌ missing $SHAPES_DIR"; exit 1; }
  ls "$PRETTY_DIR"/*.kicad_mod >/dev/null 2>&1 \
                           || { echo "    ❌ no .kicad_mod in $PRETTY_DIR"; exit 1; }
  ls "$SHAPES_DIR"/*.step >/dev/null 2>&1 \
                           || { echo "    ❌ no .step in $SHAPES_DIR"; exit 1; }
  [ -f "$ICON" ]           || { echo "    ❌ missing $ICON (icon render failed silently)"; exit 1; }
  ICON_SIZE="$(stat -c%s "$ICON")"
  [ "$ICON_SIZE" -gt 1000 ] || { echo "    ❌ $ICON is suspiciously small ($ICON_SIZE bytes)"; exit 1; }

  echo "    ✅ symbol $(stat -c%s "$SYM") B; footprint $(ls "$PRETTY_DIR"/*.kicad_mod | wc -l) file(s); 3D $(ls "$SHAPES_DIR"/*.step | wc -l) file(s); icon ${ICON_SIZE} B"
done
echo

echo "==> RPC: parts.read_file (sym + fp) returns content"
for L in C25804 C193707; do
  for K in sym fp; do
    R="$(echo "{\"id\":1,\"method\":\"parts.read_file\",\"params\":{\"staging_dir\":\"${STAGING}\",\"lcsc\":\"${L}\",\"kind\":\"${K}\"}}" \
      | timeout 10 "$SIDECAR" 2>/dev/null | grep -E '^\{"id":1' | head -1)"
    LEN="$(echo "$R" | python3 -c "import json,sys; o=json.loads(sys.stdin.read()); print(len(o.get('result',{}).get('content','')) if o.get('ok') else 0)")"
    if [ "$LEN" -lt 100 ]; then
      echo "    ❌ ${L} ${K}: ok=False or content<100 bytes"
      echo "    response: $R"
      exit 1
    fi
    echo "    ✅ ${L} ${K} → ${LEN} bytes"
  done
done

echo
echo "==> ALL SMOKE TESTS PASSED"
exit 0
