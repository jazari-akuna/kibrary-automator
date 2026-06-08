"""Workspace ZIP packaging — CLI parity for the legacy ``package_repo()``.

The legacy CLI (``kibrary_automator.py::package_repo``) exported the whole
workspace (all libraries + ``repository.json``) as a distributable ``.zip``,
skipping VCS noise and Python bytecode. The Tauri app lost this; this module
restores it as a sync, RPC-callable function.

Exclusions mirror the legacy list (``.git``, ``*.pyc``, editor backups) plus
the things the new app layout adds that don't belong in a distributable:
``.kibrary`` (staging/cache scratch), ``__pycache__`` dirs, and ``.DS_Store``.
"""
from pathlib import Path
import zipfile

# Directory names that are excluded wholesale (matched at any depth).
_EXCLUDE_DIRS = {".git", ".kibrary", "__pycache__"}

# Individual file names to drop regardless of directory.
_EXCLUDE_FILES = {".DS_Store"}

# Filename suffixes to drop (legacy dropped ``.pyc`` and editor backups ``~``).
_EXCLUDE_SUFFIXES = (".pyc", "~")


def _is_excluded(rel: Path) -> bool:
    """True if *rel* (path relative to the workspace) is non-distributable."""
    parts = rel.parts
    if any(part in _EXCLUDE_DIRS for part in parts):
        return True
    name = rel.name
    if name in _EXCLUDE_FILES:
        return True
    if name.endswith(_EXCLUDE_SUFFIXES):
        return True
    return False


def package_workspace(workspace: Path, out_path: Path | None) -> dict:
    """Zip the contents of *workspace* into a distributable archive.

    Args:
        workspace: the workspace root (libraries + ``repository.json``).
        out_path:  destination ``.zip``. When ``None``, defaults to
                   ``<workspace>/<workspace_name>.zip`` (matching the legacy CLI,
                   which wrote ``<basename(ROOT)>.zip`` into the cwd).

    Returns:
        ``{"path": <str absolute zip path>, "file_count": <int>}``.

    Raises:
        FileNotFoundError: if *workspace* is not an existing directory.
    """
    workspace = Path(workspace)
    if not workspace.is_dir():
        raise FileNotFoundError(f"Workspace path is not a directory: {workspace}")

    if out_path is None:
        out_path = workspace / f"{workspace.name}.zip"
    else:
        out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Resolve so a self-referential output (zip written inside the workspace)
    # can be skipped during the walk regardless of relative vs absolute input.
    out_resolved = out_path.resolve()

    file_count = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(workspace.rglob("*")):
            if not path.is_file():
                continue
            if path.resolve() == out_resolved:
                # Never zip the archive into itself.
                continue
            rel = path.relative_to(workspace)
            if _is_excluded(rel):
                continue
            zf.write(path, rel.as_posix())
            file_count += 1

    return {"path": str(out_path), "file_count": file_count}
