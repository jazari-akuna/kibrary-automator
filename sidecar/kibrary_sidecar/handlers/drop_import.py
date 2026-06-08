"""drop.* handlers (drag-and-drop import)."""

from pathlib import Path

from kibrary_sidecar.handlers._common import _drop_import


def drop_scan_paths(p: dict) -> dict:
    """Drag-drop import: walk dropped paths, group by stem, return manifest."""
    return _drop_import().scan_paths(p["paths"])


def drop_commit_group(p: dict) -> dict:
    """Drag-drop import: copy a scanned group into the target library."""
    return _drop_import().commit_group(
        workspace=Path(p["workspace"]),
        group=p["group"],
        target_lib=p["target_lib"],
        edits=p.get("edits") or {},
    )


REGISTRY = {
    "drop.scan_paths": drop_scan_paths,
    "drop.commit_group": drop_commit_group,
}
