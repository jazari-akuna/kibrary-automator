import json
from pathlib import Path
from typing import Any

DEFAULT_SETTINGS: dict[str, Any] = {
    "version": 1,
    "kicad_target": None,
    "git": {
        "enabled": True,
        "auto_commit": True,
        "commit_template": "Add {lcsc} ({description}) to {library}",
    },
    "concurrency": 4,
}

# Files/dirs under `.kibrary/` that are scratch space (staging, caches,
# downloaded asset blobs) and must never end up in the user's git history.
# Without this gitignore, `auto_commit` correctly classifies every in-flight
# download as "dirty outside target paths" and refuses to commit, emitting a
# scary warning that the user has no way to silence. The fix is to mark these
# scratch dirs as ignored so git stops reporting them as untracked.
#
# Workspace settings (workspace.json) IS tracked — it's intentionally part of
# the repo so settings travel with the workspace.
_KIBRARY_GITIGNORE = """\
# kibrary-automator scratch space — auto-generated, safe to keep tracked.
# These directories hold in-progress downloads, render caches, and 3D blobs
# that don't belong in the library's git history.
staging/
cache/
"""


def _settings_path(root: Path) -> Path:
    return root / ".kibrary" / "workspace.json"


def _write_kibrary_gitignore(kdir: Path) -> None:
    """Write `.kibrary/.gitignore` if missing.

    Idempotent: never overwrites a user-customised gitignore. The file is
    safe to commit (and is in fact the only file under .kibrary/ we WANT
    the user to commit, so kibrary's directory layout self-documents in
    their library repo).
    """
    gi = kdir / ".gitignore"
    if not gi.exists():
        gi.write_text(_KIBRARY_GITIGNORE)


def read_workspace_settings(root: str) -> dict:
    p = _settings_path(Path(root))
    if not p.is_file():
        return DEFAULT_SETTINGS
    return json.loads(p.read_text())


def open_workspace(root: str) -> dict:
    rp = Path(root)
    if not rp.is_dir():
        raise ValueError(f"Workspace path is not a directory: {root}")
    kdir = rp / ".kibrary"
    kdir.mkdir(exist_ok=True)
    (kdir / "staging").mkdir(exist_ok=True)
    (kdir / "cache").mkdir(exist_ok=True)
    # Self-heal pre-existing workspaces too: every open_workspace call
    # ensures the gitignore is in place. Idempotent — only writes when missing.
    _write_kibrary_gitignore(kdir)
    sp = _settings_path(rp)
    first_run = not sp.is_file()
    if first_run:
        sp.write_text(json.dumps(DEFAULT_SETTINGS, indent=2))
    return {"root": str(rp), "settings": json.loads(sp.read_text()), "first_run": first_run}
