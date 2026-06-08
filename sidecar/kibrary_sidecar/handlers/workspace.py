"""workspace.* and git.* handlers."""

from pathlib import Path

from kibrary_sidecar import workspace as ws
from kibrary_sidecar import git_ops
from kibrary_sidecar import git_undo

from kibrary_sidecar.handlers._common import _packaging


def workspace_open(p: dict) -> dict:
    return ws.open_workspace(p["root"])


def workspace_settings(p: dict) -> dict:
    return {"settings": ws.read_workspace_settings(p["root"])}


def workspace_set_settings(p: dict) -> dict:
    ws.write_workspace_settings(p["root"], p["settings"])
    return {"ok": True}


def workspace_export_zip(p: dict) -> dict:
    """Zip the workspace (all libraries + repository.json) into a
    distributable archive, excluding VCS/scratch/bytecode junk. CLI parity
    with the legacy ``package_repo()``.

    Params:
        workspace (str)         — workspace root to package.
        out_path  (str, optional) — destination .zip. Defaults to
                                    ``<workspace>/<workspace_name>.zip``.

    Returns ``{path: str, file_count: int}``.
    """
    out = Path(p["out_path"]) if p.get("out_path") else None
    return _packaging().package_workspace(Path(p["workspace"]), out)


def git_init(p: dict) -> dict:
    git_ops.init_repo(Path(p["workspace"]))
    return {"ok": True}


def git_is_safe(p: dict) -> dict:
    safe, reason = git_ops.is_safe_to_commit(Path(p["workspace"]))
    return {"safe": safe, "reason": reason}


def git_undo_last(p: dict) -> dict:
    return git_undo.undo_last_commit(Path(p["workspace"]), p["expected_sha"])


REGISTRY = {
    "workspace.open": workspace_open,
    "workspace.settings": workspace_settings,
    "workspace.set_settings": workspace_set_settings,
    "workspace.export_zip": workspace_export_zip,
    "git.init": git_init,
    "git.is_safe": git_is_safe,
    "git.undo_last": git_undo_last,
}
