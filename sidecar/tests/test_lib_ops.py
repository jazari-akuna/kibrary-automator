"""Tests for lib_ops.py — library mutation operations (Task P2, TDD).

Each test builds the minimal KiCad artefacts it needs programmatically
inside tmp_path rather than relying on shared fixtures, so tests are
hermetically independent.

Minimal file shapes used:
- .kicad_sym   — valid s-expression with one or two (symbol ...) entries
- .kicad_mod   — valid footprint s-expression
- .step        — 12-byte placeholder (only existence / copy matters)
- metadata.json / repository.json — plain JSON dicts
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from kibrary_sidecar.lib_ops import (
    delete_component,
    move_component,
    rename_component,
    rename_library,
    update_library_metadata,
)

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

_SYM_TEMPLATE = """\
(kicad_symbol_lib (version 20211014) (generator None)
  (symbol "{name}" (in_bom yes) (on_board yes)
    (property "Reference" "R" (id 0) (at 0 0 0))
    (property "Value" "10k" (id 1) (at 0 0 0))
    (property "Footprint" "{lib}:{name}" (id 2) (at 0 0 0))
    (property "Datasheet" "" (id 3) (at 0 0 0))
    (property "Description" "Test part" (id 4) (at 0 0 0))
  )
)
"""

_MOD_TEMPLATE = """\
(footprint "{name}"
  (version 20211014)
  (generator pcbnew)
  (layer "F.Cu")
  (model ${{KSL_ROOT}}/{lib}/{lib}.3dshapes/{name}.step
    (offset (xyz 0 0 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)
"""

_STEP_PLACEHOLDER = b"ISO-10303-21;\nEND-ISO-10303-21;\n"


def _make_lib(
    base: Path,
    lib_name: str,
    components: list[str],
    with_3d: bool = True,
) -> Path:
    """Build a minimal library directory structure for testing."""
    lib_dir = base / lib_name
    lib_dir.mkdir(parents=True)

    pretty = lib_dir / f"{lib_name}.pretty"
    pretty.mkdir()

    shapes: Path | None = None
    if with_3d:
        shapes = lib_dir / f"{lib_name}.3dshapes"
        shapes.mkdir()

    # .kicad_sym — one entry per component
    sym_entries = []
    for comp in components:
        sym_entries.append(
            f'  (symbol "{comp}" (in_bom yes) (on_board yes)\n'
            f'    (property "Reference" "R" (id 0) (at 0 0 0))\n'
            f'    (property "Value" "10k" (id 1) (at 0 0 0))\n'
            f'    (property "Footprint" "{lib_name}:{comp}" (id 2) (at 0 0 0))\n'
            f'    (property "Datasheet" "" (id 3) (at 0 0 0))\n'
            f'    (property "Description" "Test" (id 4) (at 0 0 0))\n'
            f'  )\n'
        )
    sym_text = (
        "(kicad_symbol_lib (version 20211014) (generator None)\n"
        + "".join(sym_entries)
        + ")\n"
    )
    (lib_dir / f"{lib_name}.kicad_sym").write_text(sym_text)

    # .kicad_mod + .step per component
    for comp in components:
        mod_text = _MOD_TEMPLATE.format(name=comp, lib=lib_name)
        (pretty / f"{comp}.kicad_mod").write_text(mod_text)
        if with_3d:
            (shapes / f"{comp}.step").write_bytes(_STEP_PLACEHOLDER)

    # metadata.json
    (lib_dir / "metadata.json").write_text(
        json.dumps({"name": lib_name, "description": lib_name})
    )

    return lib_dir


def _make_workspace(base: Path, libs: dict[str, list[str]]) -> Path:
    """Create a workspace with multiple libraries and a repository.json."""
    ws = base / "workspace"
    ws.mkdir()
    packages = []
    for lib_name, comps in libs.items():
        _make_lib(ws, lib_name, comps)
        packages.append({"path": f"{lib_name}/metadata.json"})
    (ws / "repository.json").write_text(json.dumps({"packages": packages}))
    return ws


# ---------------------------------------------------------------------------
# Test 1: rename_component updates .kicad_sym entryName, footprint ref, 3D file
# ---------------------------------------------------------------------------

def test_rename_component_updates_sym_footprint_3d(tmp_path: Path):
    lib_dir = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402"])

    rename_component(lib_dir, "R_10k_0402", "R_10k_0402_NEW")

    from kiutils.symbol import SymbolLib

    sym_path = lib_dir / "Resistors_KSL.kicad_sym"
    lib = SymbolLib.from_file(str(sym_path))
    names = [s.entryName for s in lib.symbols]

    # Old name gone, new name present
    assert "R_10k_0402" not in names
    assert "R_10k_0402_NEW" in names

    # Footprint property updated: should point to new name, not exactly the old name
    sym = next(s for s in lib.symbols if s.entryName == "R_10k_0402_NEW")
    fp_prop = next(p for p in sym.properties if p.key == "Footprint")
    assert "R_10k_0402_NEW" in fp_prop.value
    # The footprint name portion (after colon) must end in _NEW, not be the bare old name
    fp_name_part = fp_prop.value.split(":")[-1]
    assert fp_name_part == "R_10k_0402_NEW"

    # .kicad_mod renamed
    pretty = lib_dir / "Resistors_KSL.pretty"
    assert not (pretty / "R_10k_0402.kicad_mod").exists()
    assert (pretty / "R_10k_0402_NEW.kicad_mod").exists()

    # .step renamed
    shapes = lib_dir / "Resistors_KSL.3dshapes"
    assert not (shapes / "R_10k_0402.step").exists()
    assert (shapes / "R_10k_0402_NEW.step").exists()


# ---------------------------------------------------------------------------
# Test 2: rename_component raises KeyError on missing component
# ---------------------------------------------------------------------------

def test_rename_component_raises_on_missing(tmp_path: Path):
    lib_dir = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402"])

    with pytest.raises(KeyError, match="does_not_exist"):
        rename_component(lib_dir, "does_not_exist", "new_name")


# ---------------------------------------------------------------------------
# Test 3: delete_component removes symbol, .kicad_mod, and .step
# ---------------------------------------------------------------------------

def test_delete_component_removes_all_traces(tmp_path: Path):
    lib_dir = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402", "R_4k7_0402"])

    delete_component(lib_dir, "R_10k_0402")

    from kiutils.symbol import SymbolLib

    sym_path = lib_dir / "Resistors_KSL.kicad_sym"
    lib = SymbolLib.from_file(str(sym_path))
    names = [s.entryName for s in lib.symbols]

    # Deleted component gone from sym
    assert "R_10k_0402" not in names
    # Other component still present
    assert "R_4k7_0402" in names

    # .kicad_mod removed
    assert not (lib_dir / "Resistors_KSL.pretty" / "R_10k_0402.kicad_mod").exists()
    # Other footprint still present
    assert (lib_dir / "Resistors_KSL.pretty" / "R_4k7_0402.kicad_mod").exists()

    # .step removed
    assert not (lib_dir / "Resistors_KSL.3dshapes" / "R_10k_0402.step").exists()
    # Other 3D model still present
    assert (lib_dir / "Resistors_KSL.3dshapes" / "R_4k7_0402.step").exists()


# ---------------------------------------------------------------------------
# Test 4: delete_component is idempotent when component is absent
# ---------------------------------------------------------------------------

def test_delete_component_idempotent_when_absent(tmp_path: Path):
    lib_dir = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402"])

    # First call (normal)
    delete_component(lib_dir, "R_10k_0402")
    # Second call should not raise
    delete_component(lib_dir, "R_10k_0402")


# ---------------------------------------------------------------------------
# Test 5: move_component moves symbol + footprint + 3D to dst_lib
# ---------------------------------------------------------------------------

def test_move_component_between_libs(tmp_path: Path):
    src_lib = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402", "R_4k7_0402"])
    dst_lib = _make_lib(tmp_path, "Passives_KSL", ["C_100n_0402"])

    move_component(src_lib, dst_lib, "R_10k_0402")

    from kiutils.symbol import SymbolLib

    # Source: component removed
    src_sym = SymbolLib.from_file(str(src_lib / "Resistors_KSL.kicad_sym"))
    src_names = [s.entryName for s in src_sym.symbols]
    assert "R_10k_0402" not in src_names
    assert "R_4k7_0402" in src_names  # other component untouched

    # Destination: component added
    dst_sym = SymbolLib.from_file(str(dst_lib / "Passives_KSL.kicad_sym"))
    dst_names = [s.entryName for s in dst_sym.symbols]
    assert "R_10k_0402" in dst_names
    assert "C_100n_0402" in dst_names  # existing component untouched

    # Footprint reference updated to new lib
    moved_sym = next(s for s in dst_sym.symbols if s.entryName == "R_10k_0402")
    fp_prop = next(p for p in moved_sym.properties if p.key == "Footprint")
    assert fp_prop.value.startswith("Passives_KSL:")
    assert not fp_prop.value.startswith("Resistors_KSL:")

    # .kicad_mod moved
    assert not (src_lib / "Resistors_KSL.pretty" / "R_10k_0402.kicad_mod").exists()
    assert (dst_lib / "Passives_KSL.pretty" / "R_10k_0402.kicad_mod").exists()

    # .step moved
    assert not (src_lib / "Resistors_KSL.3dshapes" / "R_10k_0402.step").exists()
    assert (dst_lib / "Passives_KSL.3dshapes" / "R_10k_0402.step").exists()


# ---------------------------------------------------------------------------
# Test 6: move_component raises FileExistsError when component already in dst
# ---------------------------------------------------------------------------

def test_move_component_refuses_collision(tmp_path: Path):
    src_lib = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402"])
    dst_lib = _make_lib(tmp_path, "Passives_KSL", ["R_10k_0402"])  # same name

    with pytest.raises(FileExistsError, match="R_10k_0402"):
        move_component(src_lib, dst_lib, "R_10k_0402")


# ---------------------------------------------------------------------------
# Test 7: rename_library renames folder, internal files, updates repository.json
# ---------------------------------------------------------------------------

def test_rename_library_updates_repository_json(tmp_path: Path):
    ws = _make_workspace(tmp_path, {"Resistors_KSL": ["R_10k_0402"], "Caps_KSL": ["C_100n"]})

    rename_library(ws, "Resistors_KSL", "Passives_KSL")

    # Old dir gone, new dir present
    assert not (ws / "Resistors_KSL").exists()
    new_lib = ws / "Passives_KSL"
    assert new_lib.is_dir()

    # Internal files renamed
    assert (new_lib / "Passives_KSL.kicad_sym").is_file()
    assert (new_lib / "Passives_KSL.pretty").is_dir()
    assert (new_lib / "Passives_KSL.3dshapes").is_dir()

    # Footprint refs updated in .kicad_sym
    from kiutils.symbol import SymbolLib
    lib = SymbolLib.from_file(str(new_lib / "Passives_KSL.kicad_sym"))
    for sym in lib.symbols:
        for prop in sym.properties:
            if prop.key == "Footprint" and prop.value:
                assert not prop.value.startswith("Resistors_KSL:")
                assert prop.value.startswith("Passives_KSL:")

    # metadata.json name field updated
    meta = json.loads((new_lib / "metadata.json").read_text())
    assert meta["name"] == "Passives_KSL"

    # repository.json updated
    repo = json.loads((ws / "repository.json").read_text())
    paths = [e["path"] for e in repo["packages"]]
    assert "Resistors_KSL/metadata.json" not in paths
    assert "Passives_KSL/metadata.json" in paths
    # Other library untouched
    assert "Caps_KSL/metadata.json" in paths


# ---------------------------------------------------------------------------
# Test 8: update_library_metadata merges with existing keys
# ---------------------------------------------------------------------------

def test_update_library_metadata_merges_with_existing(tmp_path: Path):
    lib_dir = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402"])
    # metadata.json already has {"name": "Resistors_KSL", "description": "Resistors_KSL"}
    original = json.loads((lib_dir / "metadata.json").read_text())
    assert "name" in original

    update_library_metadata(lib_dir, {"description": "New description", "license": "MIT"})

    updated = json.loads((lib_dir / "metadata.json").read_text())
    # Provided keys overwritten
    assert updated["description"] == "New description"
    assert updated["license"] == "MIT"
    # Existing key "name" preserved
    assert updated["name"] == "Resistors_KSL"


# ---------------------------------------------------------------------------
# Additional test 9: rename_component with no 3D file (graceful)
# ---------------------------------------------------------------------------

def test_rename_component_without_3d_file(tmp_path: Path):
    """rename_component should work even when no .step file exists."""
    lib_dir = _make_lib(tmp_path, "Resistors_KSL", ["R_10k_0402"], with_3d=False)

    rename_component(lib_dir, "R_10k_0402", "R_10k_0402_V2")

    from kiutils.symbol import SymbolLib
    lib = SymbolLib.from_file(str(lib_dir / "Resistors_KSL.kicad_sym"))
    names = [s.entryName for s in lib.symbols]
    assert "R_10k_0402_V2" in names
    assert "R_10k_0402" not in names


# ---------------------------------------------------------------------------
# Additional test 10: rename_library when dst name already exists → error
# ---------------------------------------------------------------------------

def test_rename_library_raises_when_dst_exists(tmp_path: Path):
    ws = _make_workspace(tmp_path, {"Resistors_KSL": ["R_10k"], "Passives_KSL": ["C_100n"]})

    with pytest.raises(FileExistsError, match="Passives_KSL"):
        rename_library(ws, "Resistors_KSL", "Passives_KSL")
