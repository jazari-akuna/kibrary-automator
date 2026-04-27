#!/usr/bin/env bash
#
# release.sh — cut a kibrary-automator GitHub release with all bundles,
# signatures, and the latest.json updater manifest.
#
# Critically: the release is published WITHOUT --prerelease and WITH --latest
# so that GitHub's `releases/latest/download/<asset>` URL semantics work.
# This is what `tauri.conf.json`'s updater endpoint relies on:
#
#   "endpoints": ["https://github.com/<owner>/<repo>/releases/latest/download/latest.json"]
#
# When a release is marked --prerelease=true, GitHub's `releases/latest`
# redirect SKIPS it — the endpoint URL returns HTTP 404 and the in-app
# updater silently does nothing. This was the alpha.5 auto-update bug.
# `--latest` and `--prerelease` are mutually exclusive in the GitHub API
# (`Latest release cannot be draft or prerelease`), so the semver
# `-alpha.N` suffix is our only "this is pre-release" signal — that is
# fine because npm / Cargo / OS package managers all respect the suffix.
#
# Usage:
#   scripts/release.sh <tag>
#   e.g. scripts/release.sh v26.4.27-alpha.6
#
# Pre-reqs (the script bails if any are missing):
#   - $KIBRARY_SEARCH_API_KEY     embedded into the binary at build time
#   - $TAURI_SIGNING_PRIVATE_KEY  minisign key, set from keys/kibrary-updater.key
#   - GPG key 8E0FDC9F2E542C63    imported (for AppImage .asc detached sig)
#   - gh CLI authenticated against the repo
#   - rust toolchain on PATH (PATH="$HOME/.cargo/bin:$PATH" if needed)

set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: $0 <tag>  (e.g. v26.4.27-alpha.6)" >&2
  exit 2
fi
VER="${TAG#v}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RD="$ROOT/src-tauri/target/release/bundle"

# Sanity checks
[ -n "${KIBRARY_SEARCH_API_KEY:-}" ] || { echo "error: KIBRARY_SEARCH_API_KEY not set"; exit 2; }
[ -f "$ROOT/keys/kibrary-updater.key" ] || { echo "error: keys/kibrary-updater.key missing"; exit 2; }

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$ROOT/keys/kibrary-updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

cd "$ROOT"

echo "==> Building bundles for $VER"
pnpm tauri build --bundles deb,appimage,rpm

APPIMAGE="$RD/appimage/Kibrary_${VER}_amd64.AppImage"
DEB="$RD/deb/Kibrary_${VER}_amd64.deb"
RPM="$RD/rpm/Kibrary-${VER}-1.x86_64.rpm"

[ -f "$APPIMAGE" ] || { echo "error: $APPIMAGE missing"; exit 2; }

echo "==> Smoke test: bundled sidecar + real kicad-cli + real JLC network"
# Catches the class of bugs unit tests / mocks cannot:
#   - file-layout mismatches (alpha.6 download bug)
#   - kicad-cli flag changes (alpha.8 icon bug)
#   - JLC2KiCadLib quirks per real footprint
# .dockerignore excludes sidecar/dist, so stage the freshly-built binary
# at .smoke-build/ where the Docker build context can see it.
mkdir -p .smoke-build
cp sidecar/dist/kibrary-sidecar-x86_64-unknown-linux-gnu .smoke-build/kibrary-sidecar
docker build -q -f Dockerfile.smoke-real -t kibrary-smoke-real:${VER} . >/dev/null
if ! docker run --rm --network host kibrary-smoke-real:${VER}; then
    echo "  ❌ smoke-real failed — refusing to publish ${VER}"
    rm -rf .smoke-build
    exit 1
fi
rm -rf .smoke-build
echo

echo "==> GPG-signing AppImage"
gpg --batch --yes --detach-sign --armor --local-user 8E0FDC9F2E542C63 \
    -o "${APPIMAGE}.asc" "$APPIMAGE"

echo "==> Building latest.json"
APPIMAGE_SIG="$(cat "${APPIMAGE}.sig")"
DEB_SIG="$(cat "${DEB}.sig")"
RPM_SIG="$(cat "${RPM}.sig")"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
# Must be named exactly "latest.json" — `gh release create <file>#<label>` does
# NOT rename the asset (it sets a display label, not a filename), so a mktemp
# basename ends up as the asset name and `releases/latest/download/latest.json`
# 404s. Lesson learned the hard way in alpha.6.
LATEST_DIR="$(mktemp -d)"
LATEST_JSON="$LATEST_DIR/latest.json"
trap 'rm -rf "$LATEST_DIR"' EXIT

# tauri-updater searches platform keys in this order:
#   1.  "<os>-<arch>-<installer>"   (e.g. linux-x86_64-deb)
#   2.  "<os>-<arch>"               (fallback)
#
# The <installer> string comes from the bundle_type baked into the running
# binary at bundle time (see tauri-utils/src/platform.rs::bundle_type).
# A user who installed the .deb has bundle_type=Deb; if we only publish the
# fallback "linux-x86_64" with the AppImage URL, the deb installer downloads
# the AppImage bytes and tries to install them as a .deb (infer::is_deb
# returns false → silent fail with "update is not a valid deb package").
# This was the alpha.7 "downloads but doesn't install" bug.
#
# So we emit ONE entry per installer plus a fallback. Each installer entry
# uses the matching artifact's own .sig (tauri-bundler signs all three).
cat > "$LATEST_JSON" <<EOF
{
  "version": "${VER}",
  "notes": "See the GitHub release page for the full changelog.",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "linux-x86_64-appimage": {
      "signature": "${APPIMAGE_SIG}",
      "url": "https://github.com/jazari-akuna/kibrary-automator/releases/download/${TAG}/Kibrary_${VER}_amd64.AppImage"
    },
    "linux-x86_64-deb": {
      "signature": "${DEB_SIG}",
      "url": "https://github.com/jazari-akuna/kibrary-automator/releases/download/${TAG}/Kibrary_${VER}_amd64.deb"
    },
    "linux-x86_64-rpm": {
      "signature": "${RPM_SIG}",
      "url": "https://github.com/jazari-akuna/kibrary-automator/releases/download/${TAG}/Kibrary-${VER}-1.x86_64.rpm"
    },
    "linux-x86_64": {
      "signature": "${APPIMAGE_SIG}",
      "url": "https://github.com/jazari-akuna/kibrary-automator/releases/download/${TAG}/Kibrary_${VER}_amd64.AppImage"
    }
  }
}
EOF

echo "==> Pushing tag $TAG"
git tag "$TAG" 2>/dev/null || echo "  (tag $TAG already exists locally)"
git push origin "$TAG"

echo "==> Creating GitHub release (--latest, NOT --prerelease)"
# DO NOT pass --prerelease; see header. --latest makes
# `releases/latest/download/latest.json` resolve to this release,
# which is what the in-app updater polls.
gh release create "$TAG" \
  --title "$TAG" \
  --latest \
  --notes "Auto-generated. Edit the release on GitHub for full notes." \
  "$APPIMAGE" "${APPIMAGE}.sig" "${APPIMAGE}.asc" \
  "$DEB" "${DEB}.sig" \
  "$RPM" "${RPM}.sig" \
  "$LATEST_JSON"

echo "==> Verifying updater endpoint"
sleep 2
URL="https://github.com/jazari-akuna/kibrary-automator/releases/latest/download/latest.json"
# Must use GET not HEAD (-I): GitHub's release-asset CDN responds to HEAD
# differently than GET when chained through two 302 redirects, returning 404
# on the final hop. The tauri-updater uses GET, so we mirror that here.
STATUS="$(curl -sLo /dev/null -w '%{http_code}' "$URL")"
if [ "$STATUS" != "200" ]; then
  echo "  WARNING: endpoint returned HTTP $STATUS — auto-update will not work" >&2
  exit 1
fi
RESOLVED_VER="$(curl -sL "$URL" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")"
# Verify all three installer platform keys are present and resolve to the
# matching artifact URL. Missing any of these means a class of users
# (deb / rpm / appimage installers) silently fails to update.
EXPECTED_KEYS="linux-x86_64-appimage linux-x86_64-deb linux-x86_64-rpm linux-x86_64"
ACTUAL_KEYS="$(curl -sL "$URL" | python3 -c "import json,sys; print(' '.join(sorted(json.load(sys.stdin)['platforms'].keys())))")"
for KEY in $EXPECTED_KEYS; do
  case " $ACTUAL_KEYS " in
    *" $KEY "*) ;;
    *) echo "  WARNING: latest.json missing required platform key '$KEY' — that installer class will not auto-update" >&2; exit 1 ;;
  esac
done
echo "  OK: latest.json has all installer platform keys: $ACTUAL_KEYS"
if [ "$RESOLVED_VER" != "$VER" ]; then
  echo "  WARNING: endpoint resolves to $RESOLVED_VER, expected $VER" >&2
  exit 1
fi
echo "  OK: endpoint serves $VER"

echo "==> Done: https://github.com/jazari-akuna/kibrary-automator/releases/tag/$TAG"
