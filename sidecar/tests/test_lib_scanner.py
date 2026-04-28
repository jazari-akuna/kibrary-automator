"""Tests for lib_scanner.py — TDD (written before implementation).

Uses kiutils to build minimal .kicad_sym fixtures in-process; does NOT
depend on sidecar/tests/fixtures/sample.kicad_sym (only one symbol there).
"""

from pathlib import Path

import pytest
from kiutils.symbol import Symbol, SymbolLib


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_sym_lib(path: Path, names: list[tuple[str, str, str]]) -> None:
    """Write a .kicad_sym file with one symbol per (name, reference, value) tuple."""
    lib = SymbolLib()
    for entry_name, ref, val in names:
        sym = Symbol.create_new(id=entry_name, reference=ref, value=val)
        lib.symbols.append(sym)
    lib.to_file(str(path))


def _make_lib_dir(
    workspace: Path,
    lib_name: str,
    symbols: list[tuple[str, str, str]],
    with_pretty: bool = False,
    with_3dshapes: bool = False,
) -> Path:
    """Create a minimal library directory under *workspace* and return it."""
    lib_dir = workspace / lib_name
    lib_dir.mkdir(parents=True, exist_ok=True)
    sym_path = lib_dir / f"{lib_name}.kicad_sym"
    _write_sym_lib(sym_path, symbols)
    if with_pretty:
        (lib_dir / f"{lib_name}.pretty").mkdir()
    if with_3dshapes:
        (lib_dir / f"{lib_name}.3dshapes").mkdir()
    return lib_dir


# ---------------------------------------------------------------------------
# Import target (will fail until implementation exists)
# ---------------------------------------------------------------------------

from kibrary_sidecar.lib_scanner import (
    get_component,
    lcsc_index,
    list_components,
    list_libraries,
)
from kiutils.items.common import Effects, Font, Property


# ---------------------------------------------------------------------------
# Test 1: empty workspace → no libraries
# ---------------------------------------------------------------------------

def test_list_libraries_empty_workspace(tmp_path: Path):
    result = list_libraries(tmp_path)
    assert result == []


# ---------------------------------------------------------------------------
# Test 2: only dirs that contain <name>.kicad_sym are returned
# ---------------------------------------------------------------------------

def test_list_libraries_returns_kls_dirs_only(tmp_path: Path):
    # valid lib
    _make_lib_dir(tmp_path, "Resistors_KSL", [("R_10k", "R", "10k")])
    # directory without a matching .kicad_sym → NOT a library
    (tmp_path / "not_a_lib").mkdir()
    # file at top level → NOT a library
    (tmp_path / "README.md").write_text("hello")
    # directory with a sym file whose name doesn't match the dir → NOT a library
    mismatch_dir = tmp_path / "OtherDir"
    mismatch_dir.mkdir()
    (mismatch_dir / "WrongName.kicad_sym").write_text(
        "(kicad_symbol_lib (version 20231120) (generator t) )\n"
    )

    result = list_libraries(tmp_path)
    assert [lib["name"] for lib in result] == ["Resistors_KSL"]


# ---------------------------------------------------------------------------
# Test 3: component_count is correct
# ---------------------------------------------------------------------------

def test_list_libraries_counts_components(tmp_path: Path):
    _make_lib_dir(
        tmp_path,
        "Caps_KSL",
        [("C_100nF", "C", "100nF"), ("C_10uF", "C", "10uF"), ("C_1uF", "C", "1uF")],
    )
    _make_lib_dir(tmp_path, "Resistors_KSL", [("R_10k", "R", "10k")])

    result = list_libraries(tmp_path)
    by_name = {lib["name"]: lib for lib in result}

    assert by_name["Caps_KSL"]["component_count"] == 3
    assert by_name["Resistors_KSL"]["component_count"] == 1


# ---------------------------------------------------------------------------
# Test 4: has_pretty and has_3dshapes flags
# ---------------------------------------------------------------------------

def test_list_libraries_reports_optional_dirs(tmp_path: Path):
    _make_lib_dir(
        tmp_path,
        "Full_KSL",
        [("X", "X", "val")],
        with_pretty=True,
        with_3dshapes=True,
    )
    _make_lib_dir(tmp_path, "Bare_KSL", [("Y", "Y", "val")])

    result = list_libraries(tmp_path)
    by_name = {lib["name"]: lib for lib in result}

    assert by_name["Full_KSL"]["has_pretty"] is True
    assert by_name["Full_KSL"]["has_3dshapes"] is True
    assert by_name["Bare_KSL"]["has_pretty"] is False
    assert by_name["Bare_KSL"]["has_3dshapes"] is False


# ---------------------------------------------------------------------------
# Test 5: list_components returns symbol metadata for each symbol
# ---------------------------------------------------------------------------

def test_list_components_returns_symbol_metadata(tmp_path: Path):
    lib_dir = _make_lib_dir(
        tmp_path,
        "Resistors_KSL",
        [
            ("R_10k_0402", "R", "10k 0402"),
            ("R_4k7_0402", "R", "4.7k 0402"),
        ],
    )

    result = list_components(lib_dir)
    names = [c["name"] for c in result]
    assert "R_10k_0402" in names
    assert "R_4k7_0402" in names
    assert len(result) == 2

    # Each item has the expected keys
    for comp in result:
        assert "name" in comp
        assert "description" in comp
        assert "reference" in comp
        assert "value" in comp
        assert "footprint" in comp


# ---------------------------------------------------------------------------
# Test 6: get_component returns properties dict and path fields
# ---------------------------------------------------------------------------

def test_get_component_returns_properties_and_paths(tmp_path: Path):
    lib_dir = _make_lib_dir(
        tmp_path,
        "Diodes_KSL",
        [("D_1N4148", "D", "1N4148")],
        with_pretty=True,
        with_3dshapes=True,
    )
    # Place a footprint file and a 3D model so path resolution can work
    (lib_dir / "Diodes_KSL.pretty" / "D_1N4148.kicad_mod").write_text(
        '(footprint "D_1N4148"\n  (version 20211014)\n  (generator pcbnew)\n  (layer "F.Cu")\n)\n'
    )
    (lib_dir / "Diodes_KSL.3dshapes" / "D_1N4148.step").write_bytes(b"STEP data")

    result = get_component(lib_dir, "D_1N4148")

    assert "properties" in result
    assert isinstance(result["properties"], dict)
    assert result["properties"].get("Reference") == "D"
    assert result["properties"].get("Value") == "1N4148"

    assert "footprint_path" in result
    assert "model3d_path" in result
    # Both should be Path objects (or None)
    fp = result["footprint_path"]
    m3d = result["model3d_path"]
    assert fp is None or isinstance(fp, Path)
    assert m3d is None or isinstance(m3d, Path)


# ---------------------------------------------------------------------------
# Test 7: get_component raises KeyError for unknown component name
# ---------------------------------------------------------------------------

def test_get_component_raises_for_unknown_name(tmp_path: Path):
    lib_dir = _make_lib_dir(
        tmp_path,
        "Resistors_KSL",
        [("R_10k", "R", "10k")],
    )
    with pytest.raises(KeyError):
        get_component(lib_dir, "DoesNotExist")


# ---------------------------------------------------------------------------
# Test 8: list_libraries path field is a Path pointing to the lib directory
# ---------------------------------------------------------------------------

def test_list_libraries_path_field(tmp_path: Path):
    lib_dir = _make_lib_dir(tmp_path, "MyLib_KSL", [("X", "X", "val")])
    result = list_libraries(tmp_path)
    assert len(result) == 1
    assert result[0]["path"] == lib_dir


# ---------------------------------------------------------------------------
# lcsc_index — duplicate / already-existing component indicator
# ---------------------------------------------------------------------------

def _add_lcsc_property(lib_dir: Path, lcsc_value: str) -> None:
    """Append an `LCSC` property to the FIRST symbol in the library at lib_dir.

    Mutates the .kicad_sym file in place so we can simulate JLC2KiCadLib's
    `(property "LCSC" "C12345" ...)` field on top of fixtures built with
    Symbol.create_new (which only seeds Reference/Value/Footprint/Datasheet).
    """
    sym_path = lib_dir / f"{lib_dir.name}.kicad_sym"
    lib = SymbolLib.from_file(str(sym_path))
    sym = lib.symbols[0]
    next_id = max((p.id for p in sym.properties), default=-1) + 1
    sym.properties.append(
        Property(
            key="LCSC",
            value=lcsc_value,
            id=next_id,
            effects=Effects(font=Font(width=1.27, height=1.27), hide=True),
        )
    )
    lib.to_file(str(sym_path))


def test_lcsc_index_empty_workspace(tmp_path: Path):
    assert lcsc_index(tmp_path) == {}


def test_lcsc_index_picks_up_lcsc_named_symbols(tmp_path: Path):
    _make_lib_dir(
        tmp_path,
        "Resistors_KSL",
        [("C25804", "R", "10k 0402"), ("C12345", "R", "4.7k 0402")],
    )

    idx = lcsc_index(tmp_path)
    assert set(idx.keys()) == {"C25804", "C12345"}
    assert idx["C25804"]["library"] == "Resistors_KSL"
    assert idx["C25804"]["component_name"] == "C25804"
    assert idx["C12345"]["library"] == "Resistors_KSL"


def test_lcsc_index_uses_lcsc_property_when_renamed(tmp_path: Path):
    """Symbol renamed in LibPicker (entryName != Cnnnn) but LCSC property survives."""
    lib_dir = _make_lib_dir(
        tmp_path,
        "Resistors_KSL",
        [("R_10k_0402", "R", "10k 0402")],
    )
    _add_lcsc_property(lib_dir, "C25804")

    idx = lcsc_index(tmp_path)
    assert "C25804" in idx
    assert idx["C25804"]["library"] == "Resistors_KSL"
    # component_name surfaces the renamed entryName, not the LCSC code
    assert idx["C25804"]["component_name"] == "R_10k_0402"


def test_lcsc_index_skips_symbols_with_no_match(tmp_path: Path):
    """Symbol with neither LCSC-shaped name NOR an LCSC property is not indexed."""
    _make_lib_dir(
        tmp_path,
        "Generic_KSL",
        [("R_Generic", "R", "10k")],
    )
    assert lcsc_index(tmp_path) == {}


def test_lcsc_index_first_library_wins_on_collision(tmp_path: Path):
    """Two libraries claim the same LCSC → alphabetical-first wins."""
    _make_lib_dir(tmp_path, "ZZZ_KSL", [("C25804", "R", "10k")])
    _make_lib_dir(tmp_path, "AAA_KSL", [("C25804", "R", "10k")])

    idx = lcsc_index(tmp_path)
    # AAA_KSL comes first alphabetically (matches list_libraries' sorted walk)
    assert idx["C25804"]["library"] == "AAA_KSL"


def test_lcsc_index_skips_corrupt_kicad_sym(tmp_path: Path):
    """One corrupt library does not poison the index for the other libraries."""
    _make_lib_dir(tmp_path, "Good_KSL", [("C25804", "R", "10k")])
    bad_dir = tmp_path / "Bad_KSL"
    bad_dir.mkdir()
    (bad_dir / "Bad_KSL.kicad_sym").write_text("this is not s-expr at all")

    idx = lcsc_index(tmp_path)
    assert "C25804" in idx
    assert idx["C25804"]["library"] == "Good_KSL"


def test_lcsc_index_does_not_double_count_unit_subsymbols(tmp_path: Path):
    """Unit sub-symbols (sym.unitId is not None) must not be counted."""
    lib_dir = _make_lib_dir(tmp_path, "MultiUnit_KSL", [("C25804", "R", "10k")])
    # Manually add a unit sub-symbol whose entryName is also Cnnnn
    sym_path = lib_dir / "MultiUnit_KSL.kicad_sym"
    lib = SymbolLib.from_file(str(sym_path))
    parent = lib.symbols[0]
    unit = Symbol.create_new(id="C25804_1_1", reference="R", value="unit")
    unit.unitId = 1
    parent.units.append(unit)
    lib.to_file(str(sym_path))

    idx = lcsc_index(tmp_path)
    assert list(idx.keys()) == ["C25804"]
    # Only the parent symbol's entryName (top-level) is reported
    assert idx["C25804"]["component_name"] == "C25804"
