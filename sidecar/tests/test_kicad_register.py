"""Tests for kicad_register — Task 29: KiCad library table registration.

All tests use tmp_path and fake table files; no real KiCad needed.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from kibrary_sidecar.kicad_register import (
    list_registered,
    register_library,
    unregister_library,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_EMPTY_SYM = "(sym_lib_table\n)\n"
_EMPTY_FP = "(fp_lib_table\n)\n"


def _make_install(tmp_path: Path, *, sym_content: str = _EMPTY_SYM,
                  fp_content: str = _EMPTY_FP) -> dict:
    """Return a minimal install dict with real table files in *tmp_path*."""
    sym = tmp_path / "sym-lib-table"
    fp = tmp_path / "fp-lib-table"
    sym.write_text(sym_content)
    fp.write_text(fp_content)
    return {"sym_table": str(sym), "fp_table": str(fp)}


def _make_lib_dir(tmp_path: Path, lib_name: str, *, with_pretty: bool = True) -> Path:
    """Create a fake library directory structure."""
    lib_dir = tmp_path / "libs" / lib_name
    lib_dir.mkdir(parents=True)
    (lib_dir / f"{lib_name}.kicad_sym").write_text(
        f'(kicad_symbol_lib (version 20211014) (generator kibrary))\n'
    )
    if with_pretty:
        pretty = lib_dir / f"{lib_name}.pretty"
        pretty.mkdir()
        (pretty / f"{lib_name}.kicad_mod").write_text(
            f'(footprint "{lib_name}")\n'
        )
    return lib_dir


# ---------------------------------------------------------------------------
# Test 1: register adds entry to an empty table
# ---------------------------------------------------------------------------

def test_register_to_empty_table(tmp_path: Path):
    install = _make_install(tmp_path)
    lib_dir = _make_lib_dir(tmp_path, "MyLib")

    result = register_library(install, "MyLib", lib_dir)

    assert result["sym_added"] is True
    assert result["fp_added"] is True

    sym_text = Path(install["sym_table"]).read_text()
    assert '(name "MyLib")' in sym_text
    # New entry must appear before the closing ')'
    lines = sym_text.splitlines()
    closing_idx = next(i for i, ln in enumerate(lines) if ln.strip() == ")")
    assert any('(name "MyLib")' in lines[i] for i in range(closing_idx))

    fp_text = Path(install["fp_table"]).read_text()
    assert '(name "MyLib")' in fp_text


# ---------------------------------------------------------------------------
# Test 2: register is idempotent — second call is a no-op
# ---------------------------------------------------------------------------

def test_register_idempotent(tmp_path: Path):
    install = _make_install(tmp_path)
    lib_dir = _make_lib_dir(tmp_path, "MyLib")

    first = register_library(install, "MyLib", lib_dir)
    assert first["sym_added"] is True

    second = register_library(install, "MyLib", lib_dir)
    assert second["sym_added"] is False
    assert second["fp_added"] is False

    # Exactly one entry in file
    sym_text = Path(install["sym_table"]).read_text()
    assert sym_text.count('(name "MyLib")') == 1


# ---------------------------------------------------------------------------
# Test 3: unregister removes the entry
# ---------------------------------------------------------------------------

def test_unregister_removes_entry(tmp_path: Path):
    install = _make_install(tmp_path)
    lib_dir = _make_lib_dir(tmp_path, "MyLib")

    register_library(install, "MyLib", lib_dir)

    result = unregister_library(install, "MyLib")
    assert result["sym_removed"] is True
    assert result["fp_removed"] is True

    sym_text = Path(install["sym_table"]).read_text()
    assert '(name "MyLib")' not in sym_text

    fp_text = Path(install["fp_table"]).read_text()
    assert '(name "MyLib")' not in fp_text


# ---------------------------------------------------------------------------
# Test 4: list_registered parses names from the table
# ---------------------------------------------------------------------------

def test_list_registered_parses_lines(tmp_path: Path):
    pre_populated = (
        '(sym_lib_table\n'
        '  (lib (name "Alpha")(type "KiCad")(uri "/a")(options "")(descr ""))\n'
        '  (lib (name "Beta")(type "KiCad")(uri "/b")(options "")(descr ""))\n'
        ')\n'
    )
    install = _make_install(tmp_path, sym_content=pre_populated)

    names = list_registered(install)
    assert names == ["Alpha", "Beta"]


# ---------------------------------------------------------------------------
# Test 5: a backup is created on the first modification
# ---------------------------------------------------------------------------

def test_backup_created_on_first_modification(tmp_path: Path):
    install = _make_install(tmp_path)
    lib_dir = _make_lib_dir(tmp_path, "MyLib")

    sym_backup = Path(install["sym_table"] + ".backup")
    fp_backup = Path(install["fp_table"] + ".backup")

    assert not sym_backup.exists()
    assert not fp_backup.exists()

    register_library(install, "MyLib", lib_dir)

    assert sym_backup.exists(), "sym-lib-table backup should have been created"
    assert fp_backup.exists(), "fp-lib-table backup should have been created"

    # Backup holds the original (empty) content
    assert sym_backup.read_text() == _EMPTY_SYM
    assert fp_backup.read_text() == _EMPTY_FP

    # A second register call must NOT overwrite the existing backup
    # (backup content stays the same as original, not the already-modified file)
    register_library(install, "OtherLib", _make_lib_dir(tmp_path, "OtherLib"))
    assert sym_backup.read_text() == _EMPTY_SYM


# ---------------------------------------------------------------------------
# Bonus: fp_added is False when no .pretty dir present
# ---------------------------------------------------------------------------

def test_register_no_pretty_dir(tmp_path: Path):
    install = _make_install(tmp_path)
    lib_dir = _make_lib_dir(tmp_path, "SymOnly", with_pretty=False)

    result = register_library(install, "SymOnly", lib_dir)

    assert result["sym_added"] is True
    assert result["fp_added"] is False
    assert '(name "SymOnly")' not in Path(install["fp_table"]).read_text()


# ---------------------------------------------------------------------------
# Bonus: unregister on a name that doesn't exist returns False
# ---------------------------------------------------------------------------

def test_unregister_missing_entry(tmp_path: Path):
    install = _make_install(tmp_path)

    result = unregister_library(install, "NonExistent")
    assert result["sym_removed"] is False
    assert result["fp_removed"] is False
