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
from kibrary_sidecar import editor as kicad_editor
from kibrary_sidecar import lib_scanner
from kibrary_sidecar import lib_ops
from kibrary_sidecar import sexpr_diff
from kibrary_sidecar import model3d_ops
from kibrary_sidecar import bootstrap
from kibrary_sidecar import secrets
from kibrary_sidecar import icons as icons_mod


def system_ping(_: dict) -> dict:
    return {"pong": True}


def system_version(_: dict) -> dict:
    return {"version": __version__}


def workspace_open(p: dict) -> dict:
    return ws.open_workspace(p["root"])


def workspace_settings(p: dict) -> dict:
    return {"settings": ws.read_workspace_settings(p["root"])}


def workspace_set_settings(p: dict) -> dict:
    ws.write_workspace_settings(p["root"], p["settings"])
    return {"ok": True}


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


def library_get_3d_info(p: dict) -> dict:
    """Returns the parsed (model ...) data from the part's first .kicad_mod,
    or {info: null} if the footprint has no model block.
    Accepts both staging-style (staging_dir + lcsc) and library-style
    (lib_dir + component_name) parameters."""
    if "lib_dir" in p:
        info = files.get_3d_info(
            lib_dir=Path(p["lib_dir"]), component_name=p["component_name"]
        )
    else:
        info = files.get_3d_info(Path(p["staging_dir"]), p["lcsc"])
    return {"info": info}


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


def editor_open(p: dict) -> dict:
    """Frontend-facing wrapper: resolves the active KiCad install + the staged
    file path from {staging_dir, lcsc, kind}, then spawns the appropriate
    editor binary.

    kind: 'symbol'    → eeschema --symbol-editor on <staging>/<lcsc>/<lcsc>.kicad_sym
    kind: 'footprint' → pcbnew  --footprint-editor on the first .kicad_mod
                       in <staging>/<lcsc>/<lcsc>.pretty/.

    The 3D model offset / rotation / scale lives in the footprint, so the
    3D-preview block also calls this with kind='footprint'.
    """
    workspace_root = p.get("workspace")
    kind = p["kind"]
    staging_dir = Path(p["staging_dir"])
    lcsc = p["lcsc"]
    part_dir = staging_dir / lcsc

    if kind == "symbol":
        file_path = part_dir / f"{lcsc}.kicad_sym"
    elif kind == "footprint":
        pretty_dir = part_dir / f"{lcsc}.pretty"
        mods = sorted(pretty_dir.glob("*.kicad_mod"))
        if not mods:
            raise FileNotFoundError(f"No .kicad_mod under {pretty_dir}")
        file_path = mods[0]
    else:
        raise ValueError(f"Unsupported kind {kind!r}")

    if not file_path.is_file():
        raise FileNotFoundError(str(file_path))

    install = None
    if workspace_root:
        ws_settings = ws.read_workspace_settings(workspace_root) or {}
        target_id = ws_settings.get("kicad_target")
        for inst in kicad_install.cached_installs():
            if inst.get("id") == target_id:
                install = inst
                break
    if install is None:
        installs = kicad_install.cached_installs()
        if not installs:
            raise RuntimeError("No KiCad install detected — install KiCad first")
        install = installs[0]

    return kicad_editor.open_editor(install, kind, file_path)


def library_list(p: dict) -> dict:
    return {"libraries": lib_scanner.list_libraries(Path(p["workspace"]))}


def library_list_components(p: dict) -> dict:
    return {"components": lib_scanner.list_components(Path(p["lib_dir"]))}


def library_get_component(p: dict) -> dict:
    return lib_scanner.get_component(Path(p["lib_dir"]), p["component_name"])


def library_rename_component(p: dict) -> dict:
    lib_ops.rename_component(Path(p["lib_dir"]), p["old_name"], p["new_name"])
    return {"ok": True}


def library_delete_component(p: dict) -> dict:
    lib_ops.delete_component(Path(p["lib_dir"]), p["component_name"])
    return {"ok": True}


def library_move_component(p: dict) -> dict:
    lib_ops.move_component(Path(p["src_lib"]), Path(p["dst_lib"]), p["component_name"])
    return {"ok": True}


def library_rename_library(p: dict) -> dict:
    lib_ops.rename_library(Path(p["workspace"]), p["old"], p["new"])
    return {"ok": True}


def library_update_metadata(p: dict) -> dict:
    lib_ops.update_library_metadata(Path(p["lib_dir"]), p["metadata"])
    return {"ok": True}


def library_diff(p: dict) -> dict:
    return {"changes": sexpr_diff.diff_kicad_sym(p["before"], p["after"])}


def library_replace_3d(p: dict) -> dict:
    dst = model3d_ops.replace_3d_model(
        Path(p["lib_dir"]), p["component_name"], Path(p["new_step_path"])
    )
    return {"path": str(dst)}


def library_add_3d(p: dict) -> dict:
    dst = model3d_ops.add_3d_model(
        Path(p["lib_dir"]), p["component_name"], Path(p["src_path"])
    )
    return {"path": str(dst)}


def bootstrap_detect(p: dict) -> dict:
    candidates = p.get("candidate_paths") or []
    result = bootstrap.detect_python(candidates)
    return {"detected": result}


def bootstrap_install(p: dict) -> dict:
    target = Path(p["target_dir"])
    wheel = Path(p["wheel_path"]) if p.get("wheel_path") else None
    result = bootstrap.install_into_venv(target, wheel)
    return result


def _search_settings() -> tuple[str, str]:
    s = st.read_settings().get("search_raph_io", {})
    api_key = secrets.get_secret("search_raph_io_api_key")
    return api_key, s.get("base_url", "https://search.raph.io")


def search_query(p: dict) -> dict:
    api_key, base_url = _search_settings()
    return search_client.search(p["q"], api_key=api_key, base_url=base_url)


def search_get_part(p: dict) -> dict:
    api_key, base_url = _search_settings()
    part = search_client.get_part(p["lcsc"], api_key=api_key, base_url=base_url)
    return {"part": part}


def secrets_get(p: dict) -> dict:
    return {"value": secrets.get_secret(p["name"])}


def secrets_set(p: dict) -> dict:
    secrets.set_secret(p["name"], p["value"])
    return {"ok": True}


def secrets_delete(p: dict) -> dict:
    secrets.delete_secret(p["name"])
    return {"ok": True}


def parts_get_icon(p: dict) -> dict:
    """SVG content for a staged part's icon."""
    icon_path = Path(p["staging_dir"]) / p["lcsc"] / f"{p['lcsc']}.icon.svg"
    return {"svg": icon_path.read_text() if icon_path.is_file() else None}


def library_get_component_icon(p: dict) -> dict:
    """SVG content for a committed component's icon."""
    icons_dir = Path(p["lib_dir"]) / f"{Path(p['lib_dir']).name}.icons"
    icon_path = icons_dir / f"{p['component_name']}.svg"
    return {"svg": icon_path.read_text() if icon_path.is_file() else None}


def library_backfill_icons(p: dict) -> dict:
    """Walk workspace's _KSL libs and render missing icons."""
    return icons_mod.backfill_icons(Path(p["workspace"]))


REGISTRY = {
    "system.ping": system_ping,
    "system.version": system_version,
    "workspace.open": workspace_open,
    "workspace.settings": workspace_settings,
    "workspace.set_settings": workspace_set_settings,
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
    "editor.open": editor_open,
    "library.list": library_list,
    "library.list_components": library_list_components,
    "library.get_component": library_get_component,
    "library.rename_component": library_rename_component,
    "library.delete_component": library_delete_component,
    "library.move_component": library_move_component,
    "library.rename_library": library_rename_library,
    "library.update_metadata": library_update_metadata,
    "library.diff": library_diff,
    "library.replace_3d": library_replace_3d,
    "library.add_3d": library_add_3d,
    "library.get_3d_info": library_get_3d_info,
    "bootstrap.detect": bootstrap_detect,
    "bootstrap.install": bootstrap_install,
    "search.query": search_query,
    "search.get_part": search_get_part,
    "secrets.get": secrets_get,
    "secrets.set": secrets_set,
    "secrets.delete": secrets_delete,
    "parts.get_icon": parts_get_icon,
    "library.get_component_icon": library_get_component_icon,
    "library.backfill_icons": library_backfill_icons,
}
