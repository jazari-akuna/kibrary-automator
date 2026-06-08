"""parts.* handlers (staged-part parse / meta / props / files / icon).

SVG/3D rendering for staged parts lives in :mod:`kibrary_sidecar.handlers.render`.
"""

from pathlib import Path

from kibrary_sidecar import parser as parsemod
from kibrary_sidecar import staging
from kibrary_sidecar import files

from kibrary_sidecar.handlers._common import _symfile


def parts_parse_input(p: dict) -> dict:
    return parsemod.parse_input(p["text"])


def parts_read_meta(p: dict) -> dict:
    return {"meta": staging.read_meta(Path(p["staging_dir"]) / p["lcsc"])}


def parts_delete_staged(p: dict) -> dict:
    """Idempotently remove the staged-part directory `<staging_dir>/<lcsc>/`.

    Used by the Bulk-Assign UI's ✕ button to cancel a downloaded part
    before it gets committed to a library. Returns `{deleted: bool}`
    where False means the directory was already absent (not an error).
    """
    removed = staging.delete_staged(Path(p["staging_dir"]) / p["lcsc"])
    return {"deleted": removed}


def parts_write_meta(p: dict) -> dict:
    staging.write_meta(Path(p["staging_dir"]) / p["lcsc"], p["meta"])
    return {"ok": True}


def parts_read_props(p: dict) -> dict:
    return {"properties": _symfile().read_properties(Path(p["sym_path"]))}


def parts_write_props(p: dict) -> dict:
    _symfile().write_properties(Path(p["sym_path"]), p["edits"])
    return {"ok": True}


def parts_read_file(p: dict) -> dict:
    content = files.read_part_file(Path(p["staging_dir"]), p["lcsc"], p["kind"])
    return {"content": content}


def parts_list_dir(p: dict) -> dict:
    items = files.list_part_dir(Path(p["staging_dir"]), p["lcsc"], p.get("subdir", ""))
    return {"files": items}


def parts_get_icon(p: dict) -> dict:
    """SVG content for a staged part's icon."""
    icon_path = Path(p["staging_dir"]) / p["lcsc"] / f"{p['lcsc']}.icon.svg"
    return {"svg": icon_path.read_text() if icon_path.is_file() else None}


REGISTRY = {
    "parts.parse_input": parts_parse_input,
    "parts.read_meta": parts_read_meta,
    "parts.write_meta": parts_write_meta,
    "parts.delete_staged": parts_delete_staged,
    "parts.read_props": parts_read_props,
    "parts.write_props": parts_write_props,
    "parts.read_file": parts_read_file,
    "parts.list_dir": parts_list_dir,
    "parts.get_icon": parts_get_icon,
}
