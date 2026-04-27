#!/usr/bin/env bash
#
# smoke-ui.sh — entry point for Dockerfile.smoke-ui.
#
# Starts Xvfb, then tauri-driver (which spawns WebKitWebDriver, which launches
# /usr/bin/kibrary). A plain Node script (e2e/specs/download-all.spec.ts)
# drives the WebDriver HTTP protocol directly on port 4444. Asserts both DOM
# state and on-disk state. Exits 0 on pass, 1 on fail.
#
# Why plain Node + WebDriver HTTP rather than WebdriverIO: WDIO 9's W3C
# capability format isn't accepted by tauri-driver 2.0.5; manually posting
# `{capabilities:{alwaysMatch:{browserName:'wry', 'tauri:options':{...}}}}`
# works. Easier to use the protocol directly than to debug WDIO internals.
#
set -euo pipefail

OUT=/out
mkdir -p "$OUT"

[ -x /usr/bin/kibrary ]                       || { echo "❌ /usr/bin/kibrary missing — was the .deb installed?"; exit 1; }
command -v WebKitWebDriver >/dev/null         || { echo "❌ WebKitWebDriver missing"; exit 1; }
[ -x "${HOME}/.cargo/bin/tauri-driver" ]      || { echo "❌ tauri-driver missing"; exit 1; }

echo "==> smoke-ui prerequisites"
echo "  binary: $(dpkg -l kibrary 2>/dev/null | tail -1 | awk '{print $3}')"
echo "  driver: $($HOME/.cargo/bin/tauri-driver --help 2>&1 | head -1 || echo tauri-driver)"
echo "  node:   $(node --version)"
echo

# Start Xvfb in background.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1
export DISPLAY=:99

# Start tauri-driver in background. Crucial flags: --native-host 127.0.0.1
# (tauri-driver in Docker defaults to ::1 which fails — see issue #3815);
# --port 4444 + --native-port 4445 are the defaults but pinning them documents
# the contract for the spec script.
$HOME/.cargo/bin/tauri-driver \
    --port 4444 --native-port 4445 --native-host 127.0.0.1 \
    >/tmp/tauri-driver.log 2>&1 &
TD_PID=$!
sleep 2

cleanup() {
    kill $TD_PID 2>/dev/null || true
    kill $XVFB_PID 2>/dev/null || true
    pkill -f WebKitWebDriver 2>/dev/null || true
    pkill -f /usr/bin/kibrary 2>/dev/null || true
}
trap cleanup EXIT

# Sanity: tauri-driver listening?
if ! curl -s --max-time 2 http://127.0.0.1:4444/status >/dev/null; then
    echo "❌ tauri-driver not listening on 4444 — log:"
    cat /tmp/tauri-driver.log
    exit 1
fi

cd /e2e
echo "==> running download-all spec"
RC=0
node --experimental-strip-types specs/download-all.spec.ts || RC=$?

if [ "$RC" -eq 0 ]; then
    echo
    echo "==> ALL UI SMOKE TESTS PASSED"
    [ -f "$OUT/download-all.png" ] && echo "    screenshot: $OUT/download-all.png"
    exit 0
else
    echo
    echo "❌ UI smoke tests FAILED (exit $RC)"
    [ -f "$OUT/download-all-FAILED.png" ] && echo "    failure screenshot: $OUT/download-all-FAILED.png"
    [ -f "$OUT/download-all.png" ] && echo "    screenshot: $OUT/download-all.png"
    echo "--- tauri-driver log ---"
    tail -40 /tmp/tauri-driver.log
    exit 1
fi
