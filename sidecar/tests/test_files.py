"""Tests for kibrary_sidecar.files.read_part_file."""

from pathlib import Path

import pytest

from kibrary_sidecar.files import read_part_file

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
