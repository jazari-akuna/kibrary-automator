from pathlib import Path

from kibrary_sidecar import __version__
from kibrary_sidecar import workspace as ws
from kibrary_sidecar import settings as st
from kibrary_sidecar import parser as parsemod
from kibrary_sidecar import staging
from kibrary_sidecar import symfile
from kibrary_sidecar import category_map
from kibrary_sidecar import library
from kibrary_sidecar import git_ops
from kibrary_sidecar import git_undo
from kibrary_sidecar import search_client
from kibrary_sidecar import files
from kibrary_sidecar import kicad_install
from kibrary_sidecar import kicad_register


def system_ping(_: dict) -> dict:
    return {"pong": True}


def system_version(_: dict) -> dict:
    return {"version": __version__}


def workspace_open(p: dict) -> dict:
    return ws.open_workspace(p["root"])


def workspace_settings(p: dict) -> dict:
    return {"settings": ws.read_workspace_settings(p["root"])}


def settings_get(_: dict) -> dict:
    return {"settings": st.read_settings()}


def settings_set(p: dict) -> dict:
    st.write_settings(p["settings"])
    return {"ok": True}


def parts_parse_input(p: dict) -> dict:
    return parsemod.parse_input(p["text"])


def parts_read_meta(p: dict) -> dict:
    return {"meta": staging.read_meta(Path(p["staging_dir"]) / p["lcsc"])}


def parts_write_meta(p: dict) -> dict:
    staging.write_meta(Path(p["staging_dir"]) / p["lcsc"], p["meta"])
    return {"ok": True}


def parts_read_props(p: dict) -> dict:
    return {"properties": symfile.read_properties(Path(p["sym_path"]))}


def parts_write_props(p: dict) -> dict:
    symfile.write_properties(Path(p["sym_path"]), p["edits"])
    return {"ok": True}


def parts_read_file(p: dict) -> dict:
    content = files.read_part_file(Path(p["staging_dir"]), p["lcsc"], p["kind"])
    return {"content": content}


def parts_list_dir(p: dict) -> dict:
    items = files.list_part_dir(Path(p["staging_dir"]), p["lcsc"], p.get("subdir", ""))
    return {"files": items}


def library_suggest(p: dict) -> dict:
    return {"library": category_map.suggest_library(p["category"])}


def library_commit(p: dict) -> dict:
    """Commit a staged part to a target library, then optionally git-commit
    the change per the workspace's git settings.
    """
    workspace = Path(p["workspace"])
    lcsc = p["lcsc"]
    staging_part = Path(p["staging_dir"]) / lcsc
    target_lib = p["target_lib"]
    edits = p.get("edits", {})

    committed_path = library.commit_to_library(
        workspace, lcsc, staging_part, target_lib, edits
    )

    settings_data = ws.read_workspace_settings(str(workspace))
    git_cfg = settings_data.get("git", {}) if settings_data else {}
    sha = None
    if git_cfg.get("enabled") and git_cfg.get("auto_commit"):
        template = git_cfg.get(
            "commit_template", "Add {lcsc} ({description}) to {library}"
        )
        message = template.format(
            lcsc=lcsc,
            description=edits.get("Description", lcsc),
            library=target_lib,
        )
        paths_to_stage = [
            str(committed_path.relative_to(workspace)),
            "repository.json",
        ]
        sha = git_ops.auto_commit(workspace, message, paths_to_stage, enabled=True)

    return {"committed_path": str(committed_path), "git_sha": sha}


def git_init(p: dict) -> dict:
    git_ops.init_repo(Path(p["workspace"]))
    return {"ok": True}


def git_is_safe(p: dict) -> dict:
    safe, reason = git_ops.is_safe_to_commit(Path(p["workspace"]))
    return {"safe": safe, "reason": reason}


def git_undo_last(p: dict) -> dict:
    return git_undo.undo_last_commit(Path(p["workspace"]), p["expected_sha"])


def kicad_detect(_: dict) -> dict:
    return {"installs": kicad_install.cached_installs()}


def kicad_refresh(_: dict) -> dict:
    return {"installs": kicad_install.refresh_cache()}


def kicad_register_lib(p: dict) -> dict:
    install = p["install"]
    return kicad_register.register_library(install, p["lib_name"], Path(p["lib_dir"]))


def kicad_unregister_lib(p: dict) -> dict:
    return kicad_register.unregister_library(p["install"], p["lib_name"])


def kicad_list_registered(p: dict) -> dict:
    return {"libraries": kicad_register.list_registered(p["install"])}


def _search_settings() -> tuple[str, str]:
    s = st.read_settings().get("search_raph_io", {})
    return s.get("api_key", ""), s.get("base_url", "https://search.raph.io")


def search_query(p: dict) -> dict:
    api_key, base_url = _search_settings()
    return search_client.search(p["q"], api_key=api_key, base_url=base_url)


def search_get_part(p: dict) -> dict:
    api_key, base_url = _search_settings()
    part = search_client.get_part(p["lcsc"], api_key=api_key, base_url=base_url)
    return {"part": part}


REGISTRY = {
    "system.ping": system_ping,
    "system.version": system_version,
    "workspace.open": workspace_open,
    "workspace.settings": workspace_settings,
    "settings.get": settings_get,
    "settings.set": settings_set,
    "parts.parse_input": parts_parse_input,
    "parts.read_meta": parts_read_meta,
    "parts.write_meta": parts_write_meta,
    "parts.read_props": parts_read_props,
    "parts.write_props": parts_write_props,
    "parts.read_file": parts_read_file,
    "parts.list_dir": parts_list_dir,
    "library.suggest": library_suggest,
    "library.commit": library_commit,
    "git.init": git_init,
    "git.is_safe": git_is_safe,
    "git.undo_last": git_undo_last,
    "kicad.detect": kicad_detect,
    "kicad.refresh": kicad_refresh,
    "kicad.register": kicad_register_lib,
    "kicad.unregister": kicad_unregister_lib,
    "kicad.list_registered": kicad_list_registered,
    "search.query": search_query,
    "search.get_part": search_get_part,
}
