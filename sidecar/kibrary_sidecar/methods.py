from pathlib import Path

from kibrary_sidecar import __version__
from kibrary_sidecar import workspace as ws
from kibrary_sidecar import settings as st
from kibrary_sidecar import parser as parsemod
from kibrary_sidecar import staging
from kibrary_sidecar import symfile
from kibrary_sidecar import category_map


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
    meta = staging.read_meta(Path(p["staging_dir"]) / p["lcsc"])
    return {"meta": meta}


def parts_write_meta(p: dict) -> dict:
    staging.write_meta(Path(p["staging_dir"]) / p["lcsc"], p["meta"])
    return {"ok": True}


def parts_read_props(p: dict) -> dict:
    return {"properties": symfile.read_properties(Path(p["sym_path"]))}


def parts_write_props(p: dict) -> dict:
    symfile.write_properties(Path(p["sym_path"]), p["edits"])
    return {"ok": True}


def library_suggest(p: dict) -> dict:
    return {"library": category_map.suggest_library(p["category"])}


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
    "library.suggest": library_suggest,
}
