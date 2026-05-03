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
# Phases:
#   1. preflight  — fail fast (<60s) on stale env / drift / wrong toolchain
#   2. build      — pnpm tauri build (sidecar + frontend + Rust + bundles)
#   3. validate   — embedded key + smoke-real + smoke-ui
#   4. publish    — GPG sign + latest.json + tag + gh release + endpoint check
#
# Usage:
#   scripts/release.sh <tag>             release at tag v26.5.3-alpha.4
#   scripts/release.sh                   auto-derive tag from version files
#   scripts/release.sh --no-build        reuse cached bundles (smoke-fix retry)
#   scripts/release.sh --no-smoke        skip smoke (emergency only — loud warn)
#   scripts/release.sh --allow-dirty     skip working-tree-clean check
#   scripts/release.sh --date-skew-ok    skip CalVer date-vs-today check
#   scripts/release.sh --dry-run         everything but push/release
#
# Pre-reqs (preflight bails on any missing):
#   - $KIBRARY_SEARCH_API_KEY     embedded into the binary at build time
#                                 (auto-sourced from /root/kibrary-private/
#                                 kibrary.env if that file exists)
#   - $TAURI_SIGNING_PRIVATE_KEY  set from keys/kibrary-updater.key automatically
#   - GPG key 8E0FDC9F2E542C63    imported (for AppImage .asc detached sig)
#   - gh CLI authenticated against the repo
#   - rust toolchain (>= 1.85 for Cargo.lock v4) — auto-prepends
#     ~/.cargo/bin to PATH if the active cargo is too old

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Argument parsing
# ---------------------------------------------------------------------------

TAG=""
NO_BUILD=0
NO_SMOKE=0
ALLOW_DIRTY=0
DATE_SKEW_OK=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)       NO_BUILD=1 ;;
    --no-smoke)       NO_SMOKE=1 ;;
    --allow-dirty)    ALLOW_DIRTY=1 ;;
    --date-skew-ok)   DATE_SKEW_OK=1 ;;
    --dry-run)        DRY_RUN=1 ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# //;s/^#//' | head -40
      exit 0 ;;
    -*)
      echo "error: unknown flag '$1'" >&2; exit 2 ;;
    *)
      [ -z "$TAG" ] || { echo "error: tag specified twice ('$TAG' and '$1')" >&2; exit 2; }
      TAG="$1" ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RD="$ROOT/src-tauri/target/release/bundle"
cd "$ROOT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# pretty-printed phase header — makes long log scrubbing tolerable
hdr()   { echo;             echo "==> $*"; }
ok()    { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*" >&2; }
fail()  { echo "  ✗ $*" >&2; exit 1; }

# Find the path of a file inside a build dir, sorted by mtime, newest first.
# Replaces the SIGPIPE-prone `find | xargs stat | sort -rn | head -1 | cut`
# pipeline that died at exit 141 under `set -o pipefail` (head exits after
# reading one line → SIGPIPE upstream → pipefail catches it → release dies
# 25 minutes into the build). Using python keeps it inside one process
# with no pipes at all.
newest_file() {
  python3 - "$1" "$2" <<'PYEOF'
import os, sys, glob
root, name = sys.argv[1], sys.argv[2]
hits = []
for p, _, files in os.walk(root):
    if name in files:
        full = os.path.join(p, name)
        hits.append((os.path.getmtime(full), full))
if hits:
    hits.sort(reverse=True)
    print(hits[0][1])
PYEOF
}

# Read package.json `version` without a node dep
pkg_version() {
  python3 -c "import json; print(json.load(open('$ROOT/package.json'))['version'])"
}

# ---------------------------------------------------------------------------
# 1. PREFLIGHT — must complete in well under a minute
# ---------------------------------------------------------------------------

hdr "Preflight (1/4)"

# 1a. Auto-source /root/kibrary-private/kibrary.env if KIBRARY_SEARCH_API_KEY
# isn't already set. This is the most common reason the script bombed
# at the very first sanity check after a fresh shell.
if [ -z "${KIBRARY_SEARCH_API_KEY:-}" ] && [ -f /root/kibrary-private/kibrary.env ]; then
  set -a; . /root/kibrary-private/kibrary.env; set +a
  ok "auto-sourced /root/kibrary-private/kibrary.env"
fi
[ -n "${KIBRARY_SEARCH_API_KEY:-}" ] || fail "KIBRARY_SEARCH_API_KEY not set (and no env file at /root/kibrary-private/kibrary.env)"

# 1b. Cargo on PATH must support Cargo.lock v4 (>= 1.85). Distro-installed
# /usr/bin/cargo is often older than rustup's. Auto-prepend ~/.cargo/bin
# if the active cargo is too old — saves a 25-minute build that would
# otherwise die at the Rust step with "lock file version 4 requires
# -Znext-lockfile-bump".
REQUIRED_CARGO_MINOR=85
get_cargo_minor() { "$1" --version 2>/dev/null | awk '{split($2,a,"."); print a[2]}'; }
ACTIVE_CARGO="$(command -v cargo || true)"
if [ -n "$ACTIVE_CARGO" ]; then
  ACTIVE_MINOR="$(get_cargo_minor "$ACTIVE_CARGO" || echo 0)"
  if [ "${ACTIVE_MINOR:-0}" -lt "$REQUIRED_CARGO_MINOR" ] && [ -x "$HOME/.cargo/bin/cargo" ]; then
    HOME_MINOR="$(get_cargo_minor "$HOME/.cargo/bin/cargo")"
    if [ "${HOME_MINOR:-0}" -ge "$REQUIRED_CARGO_MINOR" ]; then
      export PATH="$HOME/.cargo/bin:$PATH"
      ok "cargo $ACTIVE_MINOR too old; prepended \$HOME/.cargo/bin (cargo 1.$HOME_MINOR)"
    fi
  fi
fi
ACTIVE_CARGO_VER="$(cargo --version 2>/dev/null || echo 'missing')"
case "$ACTIVE_CARGO_VER" in
  cargo\ 1.[0-7][0-9]*|cargo\ 1.8[0-4]*|missing)
    fail "cargo $ACTIVE_CARGO_VER too old (need 1.$REQUIRED_CARGO_MINOR+ for Cargo.lock v4)" ;;
  *) ok "$ACTIVE_CARGO_VER" ;;
esac

# 1c. Tauri signing key — read from disk before any build step touches it.
[ -f "$ROOT/keys/kibrary-updater.key" ] || fail "keys/kibrary-updater.key missing"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$ROOT/keys/kibrary-updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# 1d. GPG signing key — fails BEFORE the build if the user's gpg-agent
# forgot the key.
gpg --list-secret-keys 8E0FDC9F2E542C63 >/dev/null 2>&1 \
  || fail "GPG secret key 8E0FDC9F2E542C63 not in keyring"

# 1e. gh CLI authenticated.
gh auth status >/dev/null 2>&1 || fail "gh CLI not authenticated (run 'gh auth login')"

# 1f. Working tree clean (unless --allow-dirty). Tag carries weight; a tag
# pointing at a dirty tree means the published binary doesn't match the
# tagged commit — recurring source of "what was actually shipped?" pain.
if [ "$ALLOW_DIRTY" -eq 0 ] && ! git diff-index --quiet HEAD --; then
  echo "  ✗ working tree dirty:" >&2
  git status --short >&2
  fail "commit or stash changes (use --allow-dirty to override)"
fi

# 1g. Derive / verify tag against version files. Either:
#   - User passed a tag → must match version files (no drift between
#     CHANGELOG header, package.json, Cargo.toml, tauri.conf.json,
#     pyproject.toml, and the tag we're about to push).
#   - User didn't pass a tag → derive `v<package.json version>`.
PKG_VER="$(pkg_version)"
if [ -z "$TAG" ]; then
  TAG="v$PKG_VER"
  ok "derived tag from package.json: $TAG"
fi
VER="${TAG#v}"
[ "$VER" = "$PKG_VER" ] || fail "tag $TAG != package.json version $PKG_VER (run scripts/bump-version.sh first)"

# Each version file MUST agree — drift between them ships installer bundles
# whose embedded version disagrees with the tag the updater polls for.
for pair in \
  "src-tauri/Cargo.toml:^version = \"$VER\"$" \
  "src-tauri/tauri.conf.json:\"version\": \"$VER\"," \
  "sidecar/pyproject.toml:^version = \"$VER\"$"; do
  file="${pair%%:*}"
  pat="${pair#*:}"
  grep -qE "$pat" "$ROOT/$file" \
    || fail "$file does not contain version $VER (matched against /$pat/)"
done
ok "version files agree on $VER"

# 1h. CalVer date check — VER is "YY.M.D-alpha.N"; YY.M.D must be today
# (unless --date-skew-ok). User explicitly flagged this as a recurring
# error in past releases.
DATE_PART="${VER%-*}"
TODAY_YY_M_D="$(date -u +%y).$(date -u +%-m).$(date -u +%-d)"
if [ "$DATE_PART" != "$TODAY_YY_M_D" ]; then
  if [ "$DATE_SKEW_OK" -eq 1 ]; then
    warn "version date $DATE_PART != today $TODAY_YY_M_D (allowed via --date-skew-ok)"
  else
    fail "version date $DATE_PART != today $TODAY_YY_M_D (CalVer convention; bump with scripts/bump-version.sh, or pass --date-skew-ok)"
  fi
fi

# 1i. CHANGELOG entry exists for this version. The header convention is
# `## [<version>] — YYYY-MM-DD`. Avoids shipping with empty release notes.
if ! grep -qE "^## \[$VER\]" CHANGELOG.md; then
  fail "CHANGELOG.md missing entry '## [$VER]' — write release notes first"
fi
ok "CHANGELOG.md has entry for [$VER]"

# 1j. Tag must not already exist locally OR on origin. Re-running the
# script with the same tag after a partial failure is fine if the tag
# wasn't pushed; if it was pushed we refuse so we don't overwrite a
# published release silently.
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "refs/tags/$TAG"; then
  fail "tag $TAG already exists on origin — bump version or delete the tag (gh release delete $TAG, git push --delete origin $TAG)"
fi

# 1k. Frontend type-check (fast — <30s). Catches the alpha.35 stale-ref
# class of bug where Vite ships untyped TS and the runtime explodes.
hdr "Preflight (2/4) — Frontend type-check"
pnpm tsc --noEmit -p tsconfig.json
ok "tsc clean"

# 1l. Sidecar pytest (fast — <5s). Catches sidecar regressions BEFORE
# spending 25 minutes on Rust. The smoke-real run uses the BUNDLED
# binary, so a pytest-only regression won't be caught there until
# after the bundle.
hdr "Preflight (3/4) — Sidecar pytest"
( cd sidecar && .venv/bin/pytest -q 2>&1 | tail -8 )
ok "pytest passed"

hdr "Preflight (4/4) — Summary"
ok "tag:           $TAG"
ok "version:       $VER"
ok "today:         $TODAY_YY_M_D"
ok "no-build:      $NO_BUILD"
ok "no-smoke:      $NO_SMOKE"
ok "dry-run:       $DRY_RUN"

# ---------------------------------------------------------------------------
# 2. BUILD
# ---------------------------------------------------------------------------

APPIMAGE="$RD/appimage/Kibrary_${VER}_amd64.AppImage"
DEB="$RD/deb/Kibrary_${VER}_amd64.deb"
RPM="$RD/rpm/Kibrary-${VER}-1.x86_64.rpm"

if [ "$NO_BUILD" -eq 1 ]; then
  hdr "Build skipped (--no-build) — verifying cached artifacts"
  for f in "$APPIMAGE" "$DEB" "$RPM"; do
    [ -f "$f" ] || fail "cached artifact missing: $f (drop --no-build)"
  done
  ok "all three bundles present from previous build"
else
  hdr "Building bundles for $VER"
  pnpm tauri build --bundles deb,appimage,rpm
  for f in "$APPIMAGE" "$DEB" "$RPM"; do
    [ -f "$f" ] || fail "bundle missing after tauri build: $f"
  done
  ok "all three bundles present"
fi

# ---------------------------------------------------------------------------
# 3. VALIDATE
# ---------------------------------------------------------------------------

hdr "Verify embedded search.raph.io key actually works"
# alpha.11 shipped with the API key missing its leading `-` (read it from
# a transcript and mistook the character for a markdown bullet). The key
# happened to authenticate against /api/search but the
# /api/kibrary/parts/<lcsc>/photo endpoint requires the leading `-` —
# unit tests passed, smoke-real passed, smoke-ui passed, thumbnails
# silently 401'd in production. Decode the binary's embedded key and
# hit the live photo endpoint to prove the credential is valid.
KEY_BLOB="$(newest_file "$ROOT/src-tauri/target/release/build" search_api_key.bin)"
[ -n "$KEY_BLOB" ] && [ -f "$KEY_BLOB" ] || fail "cannot find current search_api_key.bin"
EMBEDDED_KEY="$(python3 - "$KEY_BLOB" <<'PYEOF'
import sys
mask = bytes([0x9e,0x4c,0xa1,0x33,0x77,0xd1,0x52,0x08,0xb6,0x2f,0xee,0x14,
              0x8b,0x6a,0xc7,0x39,0x05,0xfd,0x91,0x4d,0x28,0xb3,0x76,0x1c,
              0xa0,0x68,0xdb,0x47,0xf2,0x59,0x82,0x3a])
data = open(sys.argv[1], 'rb').read()
print(''.join(chr(b ^ mask[i % 32]) for i, b in enumerate(data)))
PYEOF
)"
[ -n "$EMBEDDED_KEY" ] || fail "embedded key empty — \$KIBRARY_SEARCH_API_KEY was not set during build"
PHOTO_HTTP="$(curl -s -o /dev/null -w '%{http_code}' \
              -H "Authorization: Bearer $EMBEDDED_KEY" \
              "https://search.raph.io/api/kibrary/parts/C25804/photo")"
[ "$PHOTO_HTTP" = "200" ] || fail "embedded key fails live /photo probe (HTTP $PHOTO_HTTP) — refusing to ship a binary with broken thumbnails"
ok "embedded search.raph.io key valid (HTTP 200 on live /photo endpoint)"

if [ "$NO_SMOKE" -eq 1 ]; then
  warn "SMOKE TESTS SKIPPED (--no-smoke). DO NOT use this for normal releases."
  warn "Press Ctrl+C in 5 seconds to abort:"
  sleep 5
else
  hdr "Smoke test 1/2 — sidecar + real kicad-cli + JLC network (smoke-real)"
  # Catches the class of bugs unit tests / mocks cannot:
  #   - file-layout mismatches (alpha.6 download bug)
  #   - kicad-cli flag changes (alpha.8 icon bug)
  #   - JLC2KiCadLib quirks per real footprint
  # .dockerignore excludes sidecar/dist + bundle/deb, so stage both into
  # .smoke-build/ where the Docker build context can see them.
  mkdir -p .smoke-build
  cp sidecar/dist/kibrary-sidecar-x86_64-unknown-linux-gnu .smoke-build/kibrary-sidecar
  cp "$DEB" .smoke-build/kibrary.deb
  trap 'rm -rf .smoke-build' EXIT
  docker build -q -f Dockerfile.smoke-real -t kibrary-smoke-real:${VER} . >/dev/null
  if ! docker run --rm --network host kibrary-smoke-real:${VER}; then
    fail "smoke-real failed — refusing to publish ${VER}"
  fi

  hdr "Smoke test 2/2 — real Tauri UI through tauri-driver under Xvfb (smoke-ui)"
  # Catches bugs smoke-real cannot — the alpha.10 "row stuck at downloading
  # even though file is on disk" was invisible to smoke-real (which only
  # checks the sidecar JSON-RPC response) but smoke-ui caught it on first
  # real run because the spec asserts on data-status="ready", which is set
  # by the SAME code path users hit when clicking Download all.
  docker build -q -f Dockerfile.smoke-ui -t kibrary-smoke-ui:${VER} . >/dev/null
  if ! docker run --rm --network host kibrary-smoke-ui:${VER}; then
    fail "smoke-ui failed — refusing to publish ${VER}"
  fi
fi

# ---------------------------------------------------------------------------
# 4. PUBLISH
# ---------------------------------------------------------------------------

hdr "GPG-signing AppImage"
gpg --batch --yes --detach-sign --armor --local-user 8E0FDC9F2E542C63 \
    -o "${APPIMAGE}.asc" "$APPIMAGE"
ok "${APPIMAGE}.asc"

hdr "Building latest.json"
APPIMAGE_SIG="$(cat "${APPIMAGE}.sig")"
DEB_SIG="$(cat "${DEB}.sig")"
RPM_SIG="$(cat "${RPM}.sig")"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
# Must be named exactly "latest.json" — `gh release create <file>#<label>`
# does NOT rename the asset (it sets a display label, not a filename), so a
# mktemp basename ends up as the asset name and
# `releases/latest/download/latest.json` 404s. Lesson learned the hard
# way in alpha.6.
LATEST_DIR="$(mktemp -d)"
LATEST_JSON="$LATEST_DIR/latest.json"
trap 'rm -rf "$LATEST_DIR" .smoke-build' EXIT

# tauri-updater searches platform keys in this order:
#   1. "<os>-<arch>-<installer>"   (e.g. linux-x86_64-deb)
#   2. "<os>-<arch>"               (fallback)
#
# The <installer> string comes from the bundle_type baked into the running
# binary at bundle time (see tauri-utils/src/platform.rs::bundle_type).
# A user who installed the .deb has bundle_type=Deb; if we only publish
# the fallback "linux-x86_64" with the AppImage URL, the deb installer
# downloads the AppImage bytes and tries to install them as a .deb
# (infer::is_deb returns false → silent fail with "update is not a valid
# deb package"). This was the alpha.7 "downloads but doesn't install" bug.
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
ok "$LATEST_JSON"

if [ "$DRY_RUN" -eq 1 ]; then
  hdr "DRY-RUN — stopping before tag push / gh release create"
  ok "would tag:        $TAG (HEAD: $(git rev-parse --short HEAD))"
  ok "would publish:    $APPIMAGE, $DEB, $RPM, $LATEST_JSON"
  ok "would verify:     https://github.com/jazari-akuna/kibrary-automator/releases/latest/download/latest.json"
  exit 0
fi

hdr "Pushing tag $TAG"
git tag "$TAG" 2>/dev/null || ok "tag $TAG already exists locally"
git push origin "$TAG"

hdr "Creating GitHub release (--latest, NOT --prerelease)"
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

hdr "Verifying updater endpoint"
sleep 2
URL="https://github.com/jazari-akuna/kibrary-automator/releases/latest/download/latest.json"
# Must use GET not HEAD (-I): GitHub's release-asset CDN responds to HEAD
# differently than GET when chained through two 302 redirects, returning
# 404 on the final hop. The tauri-updater uses GET, so we mirror that here.
STATUS="$(curl -sLo /dev/null -w '%{http_code}' "$URL")"
[ "$STATUS" = "200" ] || fail "endpoint returned HTTP $STATUS — auto-update will not work"
RESOLVED_VER="$(curl -sL "$URL" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")"
EXPECTED_KEYS="linux-x86_64-appimage linux-x86_64-deb linux-x86_64-rpm linux-x86_64"
ACTUAL_KEYS="$(curl -sL "$URL" | python3 -c "import json,sys; print(' '.join(sorted(json.load(sys.stdin)['platforms'].keys())))")"
for KEY in $EXPECTED_KEYS; do
  case " $ACTUAL_KEYS " in
    *" $KEY "*) ;;
    *) fail "latest.json missing required platform key '$KEY' — that installer class will not auto-update" ;;
  esac
done
ok "latest.json has all installer platform keys: $ACTUAL_KEYS"
[ "$RESOLVED_VER" = "$VER" ] || fail "endpoint resolves to $RESOLVED_VER, expected $VER"
ok "endpoint serves $VER"

hdr "Done"
echo "  https://github.com/jazari-akuna/kibrary-automator/releases/tag/$TAG"
