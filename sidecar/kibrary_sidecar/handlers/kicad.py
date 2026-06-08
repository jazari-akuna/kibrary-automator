"""kicad.* (install detection + library registration) and editor.* handlers."""

import logging
from pathlib import Path

from kibrary_sidecar import settings as st
from kibrary_sidecar import kicad_install
from kibrary_sidecar import kicad_register
from kibrary_sidecar import workspace as ws
from kibrary_sidecar import editor as kicad_editor

from kibrary_sidecar.handlers._common import _lib_scanner

log = logging.getLogger(__name__)


def kicad_detect(_: dict) -> dict:
    """Return all detected KiCad installs (cached) AND the active install id.

    alpha.18: when no active install is set yet, auto-pick the first detected
    install and persist it. This mirrors the predecessor CLI's behaviour and
    means a freshly-installed kibrary "just works" against the user's primary
    KiCad without an explicit settings step.
    """
    installs = kicad_install.cached_installs()
    active_id = st.read_settings().get("kicad_install")
    if active_id and not any(i.get("id") == active_id for i in installs):
        # Persisted id no longer matches any install (KiCad uninstalled, etc.)
        # — clear it so the auto-pick below kicks in.
        active_id = None
        st.set_active_install(None)
    if active_id is None and installs:
        active_id = installs[0]["id"]
        st.set_active_install(active_id)
    return {"installs": installs, "active": active_id}


def kicad_refresh(_: dict) -> dict:
    return {"installs": kicad_install.refresh_cache()}


def kicad_get_active(_: dict) -> dict:
    """Return the active install dict (or None) without re-running detection."""
    return {"install": st.get_active_install()}


def kicad_set_active(p: dict) -> dict:
    """Persist a new active install id. Pass id=None to clear."""
    st.set_active_install(p.get("id"))
    return {"active": p.get("id")}


def kicad_register_custom_install(p: dict) -> dict:
    """Register a user-picked KiCad binary as a custom install.

    Frontend hands us a path the user chose via the OS file dialog. We
    validate, probe ``--version``, and persist the result so it shows up in
    ``kicad.detect`` alongside auto-detected installs from now on.

    Errors (FileNotFoundError, PermissionError, ValueError) bubble up as
    JSON-RPC error responses; the frontend just toasts the message.
    """
    return kicad_install.register_custom_install(p["path"])


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

    # Library mode (Libraries room): {lib_dir, component_name, kind}
    if "lib_dir" in p and "component_name" in p:
        lib_dir = Path(p["lib_dir"])
        component_name = p["component_name"]
        if workspace_root is None:
            workspace_root = str(lib_dir.parent)
        if kind == "symbol":
            file_path = lib_dir / f"{lib_dir.name}.kicad_sym"
        elif kind == "footprint":
            fp_path = _lib_scanner()._find_footprint(lib_dir, component_name)  # type: ignore[attr-defined]
            if fp_path is None:
                raise FileNotFoundError(
                    f"No .kicad_mod for symbol {component_name!r} in {lib_dir}"
                )
            file_path = fp_path
        else:
            raise ValueError(f"Unsupported kind {kind!r}")
    else:
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


REGISTRY = {
    "kicad.detect": kicad_detect,
    "kicad.get_active": kicad_get_active,
    "kicad.set_active": kicad_set_active,
    "kicad.refresh": kicad_refresh,
    "kicad.register_custom_install": kicad_register_custom_install,
    "kicad.register": kicad_register_lib,
    "kicad.unregister": kicad_unregister_lib,
    "kicad.list_registered": kicad_list_registered,
    "editor.open": editor_open,
}
