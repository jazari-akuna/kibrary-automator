"""lib_ops.py — library mutation operations (Task P2).

Provides:
- rename_component   – rename a symbol + its footprint + 3D model
- delete_component   – remove a symbol + its footprint + 3D model (idempotent)
- move_component     – move a symbol + footprint + 3D between libraries
- rename_library     – rename a library folder and update all internal refs
- update_library_metadata – merge-update lib_dir/metadata.json
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Optional

from kiutils.symbol import SymbolLib


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sym_path(lib_dir: Path) -> Path:
    """Return the .kicad_sym path for a library directory (named after the dir)."""
    return lib_dir / f"{lib_dir.name}.kicad_sym"


def _pretty_dir(lib_dir: Path) -> Path:
    return lib_dir / f"{lib_dir.name}.pretty"


def _shapes_dir(lib_dir: Path) -> Optional[Path]:
    """Return the .3dshapes dir if it exists, else None."""
    p = lib_dir / f"{lib_dir.name}.3dshapes"
    return p if p.is_dir() else None


def _load_lib(lib_dir: Path) -> SymbolLib:
    return SymbolLib.from_file(str(_sym_path(lib_dir)))


def _find_model_file(shapes: Optional[Path], name: str) -> Optional[Path]:
    """Return first file in *shapes* whose stem matches *name*, or None."""
    if shapes is None or not shapes.is_dir():
        return None
    for f in shapes.iterdir():
        if f.stem == name:
            return f
    return None


def _rewrite_footprint_refs(lib: SymbolLib, old_lib: str, new_lib: str) -> bool:
    """Replace ``old_lib:<whatever>`` with ``new_lib:<whatever>`` in all Footprint props."""
    changed = False
    for sym in lib.symbols:
        for prop in sym.properties:
            if prop.key == "Footprint" and prop.value:
                prefix = f"{old_lib}:"
                if prop.value.startswith(prefix):
                    prop.value = f"{new_lib}:{prop.value[len(prefix):]}"
                    changed = True
    return changed


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def rename_component(lib_dir: Path, old_name: str, new_name: str) -> None:
    """Rename a symbol inside lib's .kicad_sym AND its .kicad_mod AND 3D model.

    Updates the symbol's Footprint property to point at the new fp name.
    Raises KeyError if *old_name* doesn't exist.
    """
    sym_file = _sym_path(lib_dir)
    lib = SymbolLib.from_file(str(sym_file))
    lib_name = lib_dir.name

    # Find the symbol to rename
    matching = [s for s in lib.symbols if s.entryName == old_name]
    if not matching:
        raise KeyError(f"Component {old_name!r} not found in {lib_dir}")

    # Rename in-memory
    for sym in matching:
        sym.entryName = new_name
        # Update Footprint property: e.g. "Resistors_KSL:R_10k_0402" → "...:R_10k_0402_NEW"
        for prop in sym.properties:
            if prop.key == "Footprint" and prop.value:
                # Replace only the footprint name portion (after the colon)
                if ":" in prop.value:
                    lib_part, fp_part = prop.value.split(":", 1)
                    if fp_part == old_name:
                        prop.value = f"{lib_part}:{new_name}"
                elif prop.value == old_name:
                    prop.value = new_name

    lib.to_file(str(sym_file))

    # Rename .kicad_mod
    pretty = _pretty_dir(lib_dir)
    old_mod = pretty / f"{old_name}.kicad_mod"
    if old_mod.exists():
        old_mod.rename(pretty / f"{new_name}.kicad_mod")

    # Rename 3D model file (any extension)
    shapes = _shapes_dir(lib_dir)
    old_model = _find_model_file(shapes, old_name)
    if old_model is not None:
        old_model.rename(old_model.parent / f"{new_name}{old_model.suffix}")


def delete_component(lib_dir: Path, component_name: str) -> None:
    """Remove the symbol from .kicad_sym, delete matching .kicad_mod and 3D model.

    Idempotent — does nothing if the component is absent.
    """
    sym_file = _sym_path(lib_dir)
    if not sym_file.exists():
        return

    lib = SymbolLib.from_file(str(sym_file))
    original_count = len(lib.symbols)
    lib.symbols = [s for s in lib.symbols if s.entryName != component_name]
    if len(lib.symbols) != original_count:
        lib.to_file(str(sym_file))

    # Remove .kicad_mod
    mod_file = _pretty_dir(lib_dir) / f"{component_name}.kicad_mod"
    if mod_file.exists():
        mod_file.unlink()

    # Remove 3D model (any extension)
    shapes = _shapes_dir(lib_dir)
    model_file = _find_model_file(shapes, component_name)
    if model_file is not None:
        model_file.unlink()


def move_component(src_lib: Path, dst_lib: Path, component_name: str) -> None:
    """Move a symbol + footprint + 3D model from *src_lib* to *dst_lib*.

    Updates internal Footprint refs (``SrcLib:name`` → ``DstLib:name``).
    Raises FileExistsError if *component_name* already exists in *dst_lib*.
    """
    src_name = src_lib.name
    dst_name = dst_lib.name

    # Check for collision in dst
    dst_sym_file = _sym_path(dst_lib)
    if dst_sym_file.exists():
        dst_lib_obj = SymbolLib.from_file(str(dst_sym_file))
        existing_names = {s.entryName for s in dst_lib_obj.symbols}
        if component_name in existing_names:
            raise FileExistsError(
                f"Component {component_name!r} already exists in {dst_lib}"
            )
    else:
        dst_lib_obj = SymbolLib()
        dst_lib_obj.filePath = str(dst_sym_file)

    # Load source and extract the symbol(s)
    src_sym_file = _sym_path(src_lib)
    src_lib_obj = SymbolLib.from_file(str(src_sym_file))

    to_move = [s for s in src_lib_obj.symbols if s.entryName == component_name]
    if not to_move:
        raise KeyError(f"Component {component_name!r} not found in {src_lib}")

    # Update Footprint refs in the symbols being moved
    for sym in to_move:
        for prop in sym.properties:
            if prop.key == "Footprint" and prop.value:
                if ":" in prop.value:
                    lib_part, fp_part = prop.value.split(":", 1)
                    if lib_part == src_name:
                        prop.value = f"{dst_name}:{fp_part}"
                elif prop.value:
                    prop.value = f"{dst_name}:{prop.value}"

    # Mutate src (remove) and dst (add)
    src_lib_obj.symbols = [s for s in src_lib_obj.symbols if s.entryName != component_name]
    src_lib_obj.to_file(str(src_sym_file))

    for sym in to_move:
        dst_lib_obj.symbols.append(sym)
    dst_lib_obj.to_file(str(dst_sym_file))

    # Move .kicad_mod
    src_pretty = _pretty_dir(src_lib)
    dst_pretty = _pretty_dir(dst_lib)
    dst_pretty.mkdir(exist_ok=True)
    src_mod = src_pretty / f"{component_name}.kicad_mod"
    if src_mod.exists():
        shutil.move(str(src_mod), dst_pretty / src_mod.name)

    # Move 3D model
    src_shapes = _shapes_dir(src_lib)
    src_model = _find_model_file(src_shapes, component_name)
    if src_model is not None:
        dst_shapes = dst_lib / f"{dst_name}.3dshapes"
        dst_shapes.mkdir(exist_ok=True)
        shutil.move(str(src_model), dst_shapes / src_model.name)


def rename_library(workspace: Path, old: str, new: str) -> None:
    """Rename the lib folder, its internal .kicad_sym / .pretty / .3dshapes,
    update internal sym ↔ footprint refs, update metadata.json's name field,
    and update the entry in workspace/repository.json.

    Raises FileExistsError if *new* already exists in *workspace*.
    """
    old_dir = workspace / old
    new_dir = workspace / new

    if new_dir.exists():
        raise FileExistsError(f"Library {new!r} already exists at {new_dir}")

    # Rename directory
    old_dir.rename(new_dir)

    # Rename .kicad_sym
    old_sym = new_dir / f"{old}.kicad_sym"
    new_sym = new_dir / f"{new}.kicad_sym"
    if old_sym.exists():
        old_sym.rename(new_sym)

    # Rename .pretty
    old_pretty = new_dir / f"{old}.pretty"
    new_pretty = new_dir / f"{new}.pretty"
    if old_pretty.exists():
        old_pretty.rename(new_pretty)

    # Rename .3dshapes
    old_shapes = new_dir / f"{old}.3dshapes"
    new_shapes = new_dir / f"{new}.3dshapes"
    if old_shapes.exists():
        old_shapes.rename(new_shapes)

    # Update Footprint refs in the .kicad_sym (OldLib:fp → NewLib:fp)
    if new_sym.exists():
        lib = SymbolLib.from_file(str(new_sym))
        changed = _rewrite_footprint_refs(lib, old, new)
        if changed:
            lib.to_file(str(new_sym))

    # Update metadata.json name field
    meta_path = new_dir / "metadata.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        meta["name"] = new
        meta_path.write_text(json.dumps(meta, indent=2))

    # Update repository.json
    repo_path = workspace / "repository.json"
    if repo_path.exists():
        repo = json.loads(repo_path.read_text())
        packages = repo.get("packages", [])
        for entry in packages:
            if entry.get("path") == f"{old}/metadata.json":
                entry["path"] = f"{new}/metadata.json"
        repo_path.write_text(json.dumps(repo, indent=2))


def update_library_metadata(lib_dir: Path, metadata: dict) -> None:
    """Overwrite lib_dir/metadata.json by merging *metadata* on top of existing.

    Preserves unknown keys from the existing file; provided keys take priority.
    """
    meta_path = lib_dir / "metadata.json"
    if meta_path.exists():
        existing = json.loads(meta_path.read_text())
    else:
        existing = {}
    existing.update(metadata)
    meta_path.write_text(json.dumps(existing, indent=2))
