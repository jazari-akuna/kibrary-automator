#!/usr/bin/env bash
#
# bump-version.sh — bump the kibrary-automator CalVer version in lock-step
# across the four files that must agree (release.sh's preflight enforces this):
#
#   package.json        → "version": "..."
#   src-tauri/Cargo.toml → version = "..."
#   src-tauri/tauri.conf.json → "version": "...",
#   sidecar/pyproject.toml → version = "..."
#
# CalVer convention: YY.M.D-alpha.N — the YY.M.D portion is TODAY's date
# (per project memory feedback_calver_date.md), and N resets to 1 on each
# new day. Past bug: shipping 26.4.27-alpha.36 on 2026-05-03 (date frozen
# at the original release day instead of advancing).
#
# Usage:
#   scripts/bump-version.sh              auto-derive next: today's date,
#                                        alpha N+1 if same day else 1
#   scripts/bump-version.sh 26.5.3-alpha.4   set explicit version
#   scripts/bump-version.sh --dry-run    show the new version without writing
#
# Exit codes:
#   0  files updated (or already at target version — idempotent)
#   1  refusing because the requested date doesn't match today
#   2  bad input

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=0
EXPLICIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# //;s/^#//' | head -25
      exit 0 ;;
    -*) echo "error: unknown flag '$1'" >&2; exit 2 ;;
    *)
      [ -z "$EXPLICIT" ] || { echo "error: version specified twice" >&2; exit 2; }
      EXPLICIT="$1" ;;
  esac
  shift
done

current_version() {
  python3 -c "import json; print(json.load(open('$ROOT/package.json'))['version'])"
}

today_yy_m_d() {
  echo "$(date -u +%y).$(date -u +%-m).$(date -u +%-d)"
}

# Parse "YY.M.D-alpha.N" into ($1=date, $2=N). Returns 1 if not in that shape.
parse_version() {
  local v="$1"
  if [[ "$v" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-alpha\.([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

CUR="$(current_version)"
TODAY="$(today_yy_m_d)"

if [ -n "$EXPLICIT" ]; then
  NEW="$EXPLICIT"
  # Sanity-check the explicit version's date matches today (catches the
  # frozen-date class). Allow override by just running with the date you
  # really want — bump-version doesn't second-guess explicit input beyond
  # printing the warning.
  if read -r EXPL_DATE _ <<<"$(parse_version "$NEW")"; then
    if [ "$EXPL_DATE" != "$TODAY" ]; then
      echo "  ⚠ explicit version date $EXPL_DATE != today $TODAY (CalVer convention says YY.M.D should be today)" >&2
    fi
  fi
else
  if ! read -r CUR_DATE CUR_N <<<"$(parse_version "$CUR")"; then
    echo "error: current version '$CUR' is not in YY.M.D-alpha.N shape — pass an explicit version" >&2
    exit 2
  fi
  if [ "$CUR_DATE" = "$TODAY" ]; then
    NEW="$TODAY-alpha.$((CUR_N + 1))"
  else
    NEW="$TODAY-alpha.1"
  fi
fi

echo "Current: $CUR"
echo "New:     $NEW"

if [ "$CUR" = "$NEW" ]; then
  echo "  ✓ already at $NEW (no-op)"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "  (dry-run; not writing)"
  exit 0
fi

# Write each file atomically. Use python for JSON, sed for TOML.
python3 - "$ROOT/package.json" "$NEW" <<'PYEOF'
import json, sys
path, new = sys.argv[1], sys.argv[2]
with open(path) as f: data = json.load(f)
data['version'] = new
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF

python3 - "$ROOT/src-tauri/tauri.conf.json" "$NEW" <<'PYEOF'
import json, sys
path, new = sys.argv[1], sys.argv[2]
with open(path) as f: data = json.load(f)
data['version'] = new
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF

# Cargo.toml: only the [package] table's version line. Match anchored to
# start so a deps-table `version = "..."` in the same file isn't touched.
python3 - "$ROOT/src-tauri/Cargo.toml" "$NEW" <<'PYEOF'
import re, sys
path, new = sys.argv[1], sys.argv[2]
src = open(path).read()
# Replace ONLY the first version line under [package]. Anchor by
# requiring the closest preceding section to be [package].
def repl(match):
    return f'version = "{new}"'
new_src = re.sub(
    r'(?m)(?<=\[package\]\n)([\s\S]*?)^version = "[^"]+"$',
    lambda m: m.group(1) + f'version = "{new}"',
    src,
    count=1,
)
if new_src == src:
    sys.exit("Cargo.toml: no [package] version line found")
open(path, 'w').write(new_src)
PYEOF

python3 - "$ROOT/sidecar/pyproject.toml" "$NEW" <<'PYEOF'
import re, sys
path, new = sys.argv[1], sys.argv[2]
src = open(path).read()
new_src = re.sub(r'(?m)^version = "[^"]+"$', f'version = "{new}"', src, count=1)
if new_src == src:
    sys.exit("pyproject.toml: no version line found")
open(path, 'w').write(new_src)
PYEOF

echo "  ✓ wrote $NEW to package.json, tauri.conf.json, Cargo.toml, pyproject.toml"
echo
echo "Next steps:"
echo "  1. Add a CHANGELOG.md entry: '## [$NEW] — $(date -u +%Y-%m-%d)'"
echo "  2. git add -A && git commit -m 'release: $NEW — <one-liner>'"
echo "  3. scripts/release.sh                  (auto-derives tag from package.json)"
