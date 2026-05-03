#!/usr/bin/env bash
#
# visual-verify.sh — local entry for the 3D-viewer visual verification
# harness. Mirrors smoke-ui.sh's Xvfb + tauri-driver bootstrap, then
# runs e2e/visual-verify/runner.ts against the installed kibrary binary.
#
# Args:
#   $1            (optional) fixture name to run (--fixture <name>)
#   --debug       keep WebDriver session alive on first FAIL
#
# Output dir: /tmp/visual-verify-out (override via VISUAL_VERIFY_OUT env).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${VISUAL_VERIFY_OUT:-/tmp/visual-verify-out}"
WORKSPACE="${VISUAL_VERIFY_WORKSPACE:-/tmp/visual-verify-workspace}"
KEEP_SESSION=0
FIXTURE=""

for arg in "$@"; do
  case "$arg" in
    --debug) KEEP_SESSION=1 ;;
    --help|-h)
      echo "Usage: scripts/visual-verify.sh [fixture-name] [--debug]"
      echo "       output dir = ${OUT}"
      exit 0
      ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) FIXTURE="$arg" ;;
  esac
done

mkdir -p "$OUT"

# Build the per-fixture KSL workspace BEFORE touching tauri-driver. The
# runner reads $VISUAL_VERIFY_WORKSPACE; the fixtures.json default also
# matches so a stale env doesn't accidentally point at /tmp/e2e-workspace.
echo "==> setting up visual-verify workspace at ${WORKSPACE}"
VISUAL_VERIFY_WORKSPACE="$WORKSPACE" bash "$REPO_ROOT/e2e/visual-verify/setup-workspace.sh"

# If the host doesn't have /usr/bin/kibrary + tauri-driver (typical
# headless dev box), fall back to running the harness inside the
# kibrary-smoke-ui Docker image — it bundles all three. The image tag
# can be overridden with VISUAL_VERIFY_IMAGE; default tracks the most
# recent tag built on this box.
if ! [ -x /usr/bin/kibrary ] || ! command -v WebKitWebDriver >/dev/null \
   || ! [ -x "${HOME}/.cargo/bin/tauri-driver" ]; then
  IMAGE="${VISUAL_VERIFY_IMAGE:-kibrary-smoke-ui:latest}"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    # Find the newest local kibrary-smoke-ui:* tag as a sensible default.
    IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' \
              | grep '^kibrary-smoke-ui:' | head -1 || true)"
  fi
  if [ -z "$IMAGE" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "❌ no host kibrary binary AND no kibrary-smoke-ui Docker image found." >&2
    echo "   Build one via: bash scripts/smoke-ui.sh  (or any release)." >&2
    exit 1
  fi
  echo "==> host has no kibrary; running in Docker image ${IMAGE}"
  ARGS_INNER=(--out /out)
  [ -n "$FIXTURE" ] && ARGS_INNER+=(--fixture "$FIXTURE")
  [ "$KEEP_SESSION" -eq 1 ] && ARGS_INNER+=(--debug)
  exec docker run --rm --network host \
    -v "$REPO_ROOT/e2e:/e2e:ro" \
    -v "$WORKSPACE:/workspace:rw" \
    -v "$OUT:/out:rw" \
    -e VISUAL_VERIFY_OUT=/out \
    -e VISUAL_VERIFY_WORKSPACE=/workspace \
    "$IMAGE" \
    bash -c '
      set -e
      Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
      sleep 1
      export DISPLAY=:99
      /root/.cargo/bin/tauri-driver --port 4444 --native-port 4445 --native-host 127.0.0.1 >/tmp/td.log 2>&1 &
      sleep 2
      curl -s --max-time 2 http://127.0.0.1:4444/status >/dev/null || { cat /tmp/td.log; exit 1; }
      cd /e2e
      RC=0
      node --experimental-strip-types visual-verify/runner.ts '"${ARGS_INNER[*]}"' || RC=$?
      echo "--- tauri-driver tail ---"; tail -30 /tmp/td.log
      exit $RC
    '
fi
TAURI_DRIVER="${TAURI_DRIVER:-${HOME}/.cargo/bin/tauri-driver}"

echo "==> visual-verify prerequisites"
echo "  binary:  $(dpkg -l kibrary 2>/dev/null | tail -1 | awk '{print $3}')"
echo "  driver:  $(${TAURI_DRIVER} --help 2>&1 | head -1 || echo tauri-driver)"
echo "  node:    $(node --version)"
echo "  out:     ${OUT}"
echo "  fixture: ${FIXTURE:-<all>}"
echo "  debug:   ${KEEP_SESSION}"
echo

# Xvfb on :99
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb-vv.log 2>&1 &
XVFB_PID=$!
sleep 1
export DISPLAY=:99

# tauri-driver on 4444
"$TAURI_DRIVER" \
    --port 4444 --native-port 4445 --native-host 127.0.0.1 \
    >/tmp/tauri-driver-vv.log 2>&1 &
TD_PID=$!
sleep 2

cleanup() {
  if [ "$KEEP_SESSION" -eq 1 ] && [ -n "${KEEP_ALIVE:-}" ]; then
    echo "==> --debug + FAIL — keeping tauri-driver + Xvfb alive (PIDs $TD_PID / $XVFB_PID)"
    echo "    Inspect: tail -f /tmp/tauri-driver-vv.log"
    return
  fi
  kill "$TD_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  pkill -f WebKitWebDriver 2>/dev/null || true
  pkill -f /usr/bin/kibrary 2>/dev/null || true
}
trap cleanup EXIT

if ! curl -s --max-time 2 http://127.0.0.1:4444/status >/dev/null; then
  echo "❌ tauri-driver not listening on 4444 — log:"
  cat /tmp/tauri-driver-vv.log
  exit 1
fi

echo "==> running visual-verify runner"
ARGS=(--out "$OUT")
[ -n "$FIXTURE" ] && ARGS+=(--fixture "$FIXTURE")
[ "$KEEP_SESSION" -eq 1 ] && ARGS+=(--debug)

cd "$REPO_ROOT"
RC=0
VISUAL_VERIFY_OUT="$OUT" VISUAL_VERIFY_WORKSPACE="$WORKSPACE" \
  node --experimental-strip-types e2e/visual-verify/runner.ts "${ARGS[@]}" || RC=$?

if [ "$RC" -eq 0 ]; then
  echo
  echo "==> ALL VISUAL-VERIFY FIXTURES PASSED"
  echo "    artefacts: ${OUT}"
  exit 0
else
  echo
  echo "❌ VISUAL-VERIFY FAILED (exit $RC)"
  echo "    artefacts: ${OUT}"
  if [ "$KEEP_SESSION" -eq 1 ]; then
    KEEP_ALIVE=1
    export KEEP_ALIVE
  fi
  echo "--- tauri-driver log (last 40) ---"
  tail -40 /tmp/tauri-driver-vv.log
  exit 1
fi
