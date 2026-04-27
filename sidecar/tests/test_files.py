"""Tests for kibrary_sidecar.files.read_part_file and get_3d_info."""

from pathlib import Path

import pytest

from kibrary_sidecar.files import read_library_file, read_part_file, get_3d_info

LCSC = "C99999"


def _make_staging(tmp_path: Path) -> Path:
    """Create a minimal staging directory layout for LCSC *C99999*."""
    part_dir = tmp_path / LCSC
    part_dir.mkdir()
    return tmp_path


# ---------------------------------------------------------------------------
# Symbol
# ---------------------------------------------------------------------------


def test_read_sym_returns_content(tmp_path):
    staging = _make_staging(tmp_path)
    sym_content = "(kicad_symbol_lib (version 20211014) (generator test))"
    (staging / LCSC / f"{LCSC}.kicad_sym").write_text(sym_content, encoding="utf-8")

    result = read_part_file(staging, LCSC, "sym")

    assert result == sym_content


def test_read_sym_missing_raises(tmp_path):
    staging = _make_staging(tmp_path)
    # No .kicad_sym file created

    with pytest.raises(FileNotFoundError, match="Symbol file not found"):
        read_part_file(staging, LCSC, "sym")


# ---------------------------------------------------------------------------
# Footprint
# ---------------------------------------------------------------------------


def test_read_fp_returns_first_mod_content(tmp_path):
    staging = _make_staging(tmp_path)
    pretty_dir = staging / LCSC / f"{LCSC}.pretty"
    pretty_dir.mkdir()
    fp_content = "(module C99999 (layer F.Cu))"
    (pretty_dir / f"{LCSC}.kicad_mod").write_text(fp_content, encoding="utf-8")

    result = read_part_file(staging, LCSC, "fp")

    assert result == fp_content


def test_read_fp_returns_first_of_multiple_mods(tmp_path):
    """When multiple .kicad_mod files exist, the sorted-first one is returned."""
    staging = _make_staging(tmp_path)
    pretty_dir = staging / LCSC / f"{LCSC}.pretty"
    pretty_dir.mkdir()
    (pretty_dir / "aaa.kicad_mod").write_text("first", encoding="utf-8")
    (pretty_dir / "zzz.kicad_mod").write_text("second", encoding="utf-8")

    result = read_part_file(staging, LCSC, "fp")

    assert result == "first"


def test_read_fp_missing_pretty_dir_raises(tmp_path):
    staging = _make_staging(tmp_path)
    # No .pretty directory created

    with pytest.raises(FileNotFoundError, match="Footprint directory not found"):
        read_part_file(staging, LCSC, "fp")


def test_read_fp_empty_pretty_dir_raises(tmp_path):
    staging = _make_staging(tmp_path)
    pretty_dir = staging / LCSC / f"{LCSC}.pretty"
    pretty_dir.mkdir()
    # No .kicad_mod files inside

    with pytest.raises(FileNotFoundError, match="No .kicad_mod files found"):
        read_part_file(staging, LCSC, "fp")


# ---------------------------------------------------------------------------
# Invalid kind
# ---------------------------------------------------------------------------


def test_invalid_kind_raises_value_error(tmp_path):
    staging = _make_staging(tmp_path)

    with pytest.raises(ValueError, match="Unsupported kind"):
        read_part_file(staging, LCSC, "unknown")


# ---------------------------------------------------------------------------
# get_3d_info
# ---------------------------------------------------------------------------

_KSL = "${KSL_ROOT}"

_MOD_WITH_MODEL = (
    '(footprint "C99999"\n'
    '  (layer "F.Cu")\n'
    f'  (model "{_KSL}/TestLib/TestLib.3dshapes/C99999.step"\n'
    '    (offset (xyz 1.0 2.0 3.0))\n'
    '    (scale (xyz 1.0 1.0 1.0))\n'
    '    (rotate (xyz 0.0 45.0 90.0))\n'
    '  )\n'
    ')\n'
)

_MOD_NO_MODEL = (
    '(footprint "C99999"\n'
    '  (layer "F.Cu")\n'
    ')\n'
)

_MOD_MULTI_MODEL = (
    '(footprint "C99999"\n'
    '  (layer "F.Cu")\n'
    f'  (model "{_KSL}/TestLib/TestLib.3dshapes/C99999.step"\n'
    '    (offset (xyz 0.0 0.0 0.0))\n'
    '    (scale (xyz 1.0 1.0 1.0))\n'
    '    (rotate (xyz 0.0 0.0 0.0))\n'
    '  )\n'
    f'  (model "{_KSL}/TestLib/TestLib.3dshapes/C99999_alt.wrl"\n'
    '    (offset (xyz 9.0 9.0 9.0))\n'
    '    (scale (xyz 2.0 2.0 2.0))\n'
    '    (rotate (xyz 180.0 0.0 0.0))\n'
    '  )\n'
    ')\n'
)


def _make_pretty(staging: Path, content: str) -> Path:
    """Write *content* as a .kicad_mod file in <staging>/<LCSC>/<LCSC>.pretty/."""
    pretty_dir = staging / LCSC / f"{LCSC}.pretty"
    pretty_dir.mkdir(parents=True, exist_ok=True)
    mod_path = pretty_dir / f"{LCSC}.kicad_mod"
    mod_path.write_text(content, encoding="utf-8")
    return staging


def test_get_3d_info_returns_model_data(tmp_path):
    staging = _make_pretty(tmp_path, _MOD_WITH_MODEL)

    result = get_3d_info(staging, LCSC)

    assert result is not None
    assert result["filename"] == "C99999.step"
    assert result["format"] == "step"
    assert "${KSL_ROOT}" in result["model_path"]
    assert result["offset"] == [1.0, 2.0, 3.0]
    assert result["rotation"] == [0.0, 45.0, 90.0]
    assert result["scale"] == [1.0, 1.0, 1.0]


def test_get_3d_info_returns_none_when_no_model(tmp_path):
    staging = _make_pretty(tmp_path, _MOD_NO_MODEL)

    result = get_3d_info(staging, LCSC)

    assert result is None


def test_get_3d_info_picks_first_when_multiple_models(tmp_path):
    staging = _make_pretty(tmp_path, _MOD_MULTI_MODEL)

    result = get_3d_info(staging, LCSC)

    assert result is not None
    assert result["filename"] == "C99999.step"
    assert result["format"] == "step"
    # First model's offset/rotation/scale should be used
    assert result["offset"] == [0.0, 0.0, 0.0]
    assert result["rotation"] == [0.0, 0.0, 0.0]
    assert result["scale"] == [1.0, 1.0, 1.0]


# ---------------------------------------------------------------------------
# read_library_file (committed-library layout)
# ---------------------------------------------------------------------------


def _make_library_layout(base: Path) -> Path:
    """Create a minimal committed-library layout for the read_library_file tests.

    Layout:
        base/Lib_KSL/
            Lib_KSL.kicad_sym         (two symbols)
            Lib_KSL.pretty/
                A.kicad_mod
                B.kicad_mod
    """
    from kiutils.symbol import Symbol, SymbolLib

    lib_dir = base / "Lib_KSL"
    lib_dir.mkdir(parents=True)

    lib = SymbolLib()
    lib.symbols.append(Symbol.create_new(id="A", reference="A", value="alpha"))
    lib.symbols.append(Symbol.create_new(id="B", reference="B", value="beta"))
    lib.to_file(str(lib_dir / "Lib_KSL.kicad_sym"))

    pretty = lib_dir / "Lib_KSL.pretty"
    pretty.mkdir()
    (pretty / "A.kicad_mod").write_text(
        '(footprint "A" (layer "F.Cu"))', encoding="utf-8"
    )
    (pretty / "B.kicad_mod").write_text(
        '(footprint "B" (layer "F.Cu"))', encoding="utf-8"
    )
    return lib_dir


def test_read_library_file_sym_returns_single_symbol(tmp_path):
    lib_dir = _make_library_layout(tmp_path)

    content = read_library_file(lib_dir, "A", "sym")

    # The returned text is a single-symbol library.
    assert "kicad_symbol_lib" in content
    assert '"A"' in content
    # B should NOT be in the sliced output.
    assert '"B"' not in content


def test_read_library_file_sym_missing_symbol_raises(tmp_path):
    lib_dir = _make_library_layout(tmp_path)

    with pytest.raises(FileNotFoundError):
        read_library_file(lib_dir, "DoesNotExist", "sym")


def test_read_library_file_fp_returns_kicad_mod_text(tmp_path):
    lib_dir = _make_library_layout(tmp_path)

    content = read_library_file(lib_dir, "B", "fp")

    assert content == '(footprint "B" (layer "F.Cu"))'


def test_read_library_file_fp_missing_raises(tmp_path):
    lib_dir = _make_library_layout(tmp_path)

    with pytest.raises(FileNotFoundError):
        read_library_file(lib_dir, "DoesNotExist", "fp")


def test_read_library_file_invalid_kind_raises(tmp_path):
    lib_dir = _make_library_layout(tmp_path)

    with pytest.raises(ValueError, match="Unsupported kind"):
        read_library_file(lib_dir, "A", "3d")
