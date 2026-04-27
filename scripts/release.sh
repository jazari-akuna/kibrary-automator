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

echo "==> GPG-signing AppImage"
gpg --batch --yes --detach-sign --armor --local-user 8E0FDC9F2E542C63 \
    -o "${APPIMAGE}.asc" "$APPIMAGE"

echo "==> Building latest.json"
APPIMAGE_SIG="$(cat "${APPIMAGE}.sig")"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
LATEST_JSON="$(mktemp)"
cat > "$LATEST_JSON" <<EOF
{
  "version": "${VER}",
  "notes": "See the GitHub release page for the full changelog.",
  "pub_date": "${PUB_DATE}",
  "platforms": {
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
  "$LATEST_JSON#latest.json"

echo "==> Verifying updater endpoint"
sleep 2
URL="https://github.com/jazari-akuna/kibrary-automator/releases/latest/download/latest.json"
STATUS="$(curl -sILo /dev/null -w '%{http_code}' "$URL")"
if [ "$STATUS" != "200" ]; then
  echo "  WARNING: endpoint returned HTTP $STATUS — auto-update will not work" >&2
  exit 1
fi
RESOLVED_VER="$(curl -sL "$URL" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")"
if [ "$RESOLVED_VER" != "$VER" ]; then
  echo "  WARNING: endpoint resolves to $RESOLVED_VER, expected $VER" >&2
  exit 1
fi
echo "  OK: endpoint serves $VER"

echo "==> Done: https://github.com/jazari-akuna/kibrary-automator/releases/tag/$TAG"
