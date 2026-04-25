"""Tests for library.commit_to_library (Task 23, TDD).

Staging layout expected by commit_to_library:
  staging_part/<lcsc>.kicad_sym
  staging_part/<lcsc>.pretty/<lcsc>.kicad_mod
  staging_part/<lcsc>.3dshapes/<model>.wrl   (optional)
"""
import json
from pathlib import Path

import pytest

from kibrary_sidecar.library import commit_to_library
from kibrary_sidecar.symfile import read_properties

FIXTURE_SYM = Path(__file__).parent / "fixtures" / "sample.kicad_sym"
LCSC = "C25804"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_staging(base: Path, lcsc: str, with_3d: bool = False) -> Path:
    """Create a minimal staging_part directory for *lcsc*."""
    staging_part = base / lcsc
    staging_part.mkdir(parents=True)

    # Symbol file
    sym = staging_part / f"{lcsc}.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())

    # Footprint dir + placeholder .kicad_mod
    pretty = staging_part / f"{lcsc}.pretty"
    pretty.mkdir()
    (pretty / f"{lcsc}.kicad_mod").write_text(
        f'(footprint "{lcsc}"\n  (version 20211014)\n  (generator pcbnew)\n  (layer "F.Cu")\n)\n'
    )

    # Optional 3D models dir
    if with_3d:
        shapes = staging_part / f"{lcsc}.3dshapes"
        shapes.mkdir()
        (shapes / f"{lcsc}.wrl").write_text("#VRML V2.0 utf8\n")

    return staging_part


# ---------------------------------------------------------------------------
# Test 1: create-new path
# ---------------------------------------------------------------------------

def test_commit_creates_new_library_when_target_missing(tmp_path: Path):
    staging_part = _make_staging(tmp_path / "staging", LCSC, with_3d=True)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target_lib = "Capacitors_KSL"

    result = commit_to_library(
        workspace=workspace,
        lcsc=LCSC,
        staging_part=staging_part,
        target_lib=target_lib,
        edits={},
    )

    lib_dir = workspace / target_lib
    assert result == lib_dir
    assert result.is_dir()

    # Symbol file moved
    assert (lib_dir / f"{target_lib}.kicad_sym").is_file()

    # Footprint dir moved
    pretty = lib_dir / f"{target_lib}.pretty"
    assert pretty.is_dir()
    assert (pretty / f"{LCSC}.kicad_mod").is_file()

    # 3D shapes moved
    shapes = lib_dir / f"{target_lib}.3dshapes"
    assert shapes.is_dir()
    assert (shapes / f"{LCSC}.wrl").is_file()

    # metadata.json created (PCM format)
    meta_path = lib_dir / "metadata.json"
    assert meta_path.is_file()
    meta = json.loads(meta_path.read_text())
    assert meta["name"] == target_lib
    assert meta["type"] == "library"
    assert "$schema" in meta

    # repository.json appended
    repo_path = workspace / "repository.json"
    assert repo_path.is_file()
    repo = json.loads(repo_path.read_text())
    entries = repo.get("packages", [])
    assert any(e["path"] == f"{target_lib}/metadata.json" for e in entries)


# ---------------------------------------------------------------------------
# Test 2: merge-into path
# ---------------------------------------------------------------------------

def test_commit_merges_into_existing_library(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target_lib = "Resistors_KSL"

    # First commit — creates the library
    lcsc_a = "C25804"
    staging_a = _make_staging(tmp_path / "staging_a", lcsc_a)
    commit_to_library(
        workspace=workspace,
        lcsc=lcsc_a,
        staging_part=staging_a,
        target_lib=target_lib,
        edits={},
    )

    # Verify repository.json has exactly one entry now
    repo_before = json.loads((workspace / "repository.json").read_text())
    entries_before = repo_before.get("packages", [])
    assert len([e for e in entries_before if e["path"] == f"{target_lib}/metadata.json"]) == 1

    # Second commit — merges into existing library
    lcsc_b = "C99999"
    # We need a staging sym for the second part (rename the sample's entryName)
    staging_b = tmp_path / "staging_b" / lcsc_b
    staging_b.mkdir(parents=True)
    sym_b = staging_b / f"{lcsc_b}.kicad_sym"
    # Build a minimal kicad_sym with a different symbol name
    sym_b.write_text(
        f'(kicad_symbol_lib (version 20211014) (generator None)\n'
        f'  (symbol "{lcsc_b}" (in_bom yes) (on_board yes)\n'
        f'    (property "Reference" "R" (id 0) (at 0.0 0.0 0))\n'
        f'    (property "Value" "10k 0402" (id 1) (at 0.0 0.0 0))\n'
        f'    (property "Footprint" "" (id 2) (at 0.0 0.0 0))\n'
        f'    (property "Datasheet" "" (id 3) (at 0.0 0.0 0))\n'
        f'  )\n'
        f')\n'
    )
    pretty_b = staging_b / f"{lcsc_b}.pretty"
    pretty_b.mkdir()
    (pretty_b / f"{lcsc_b}.kicad_mod").write_text(
        f'(footprint "{lcsc_b}"\n  (version 20211014)\n  (generator pcbnew)\n  (layer "F.Cu")\n)\n'
    )

    result = commit_to_library(
        workspace=workspace,
        lcsc=lcsc_b,
        staging_part=staging_b,
        target_lib=target_lib,
        edits={},
    )

    lib_dir = workspace / target_lib
    assert result == lib_dir

    # Both symbols present in the merged lib
    from kiutils.symbol import SymbolLib
    merged_lib = SymbolLib().from_file(str(lib_dir / f"{target_lib}.kicad_sym"))
    names = [s.entryName for s in merged_lib.symbols]
    assert lcsc_a in names
    assert lcsc_b in names

    # Second footprint copied
    assert (lib_dir / f"{target_lib}.pretty" / f"{lcsc_b}.kicad_mod").is_file()

    # repository.json NOT appended a second time
    repo_after = json.loads((workspace / "repository.json").read_text())
    entries_after = repo_after.get("packages", [])
    count = len([e for e in entries_after if e["path"] == f"{target_lib}/metadata.json"])
    assert count == 1, f"Expected exactly 1 entry, got {count}"


# ---------------------------------------------------------------------------
# Test 3: edits applied
# ---------------------------------------------------------------------------

def test_edits_applied_to_committed_symbol(tmp_path: Path):
    staging_part = _make_staging(tmp_path / "staging", LCSC)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target_lib = "MyParts_KSL"

    commit_to_library(
        workspace=workspace,
        lcsc=LCSC,
        staging_part=staging_part,
        target_lib=target_lib,
        edits={"Description": "100nF bypass cap", "Reference": "C?"},
    )

    sym_path = workspace / target_lib / f"{target_lib}.kicad_sym"
    props = read_properties(sym_path)
    assert props["Description"] == "100nF bypass cap"
    assert props["Reference"] == "C?"


# ---------------------------------------------------------------------------
# Test 4: 3D model paths rewritten in footprints
# ---------------------------------------------------------------------------

def test_3d_model_paths_rewritten_in_footprints(tmp_path: Path):
    """Footprint .kicad_mod files should have 3D paths updated to ${KSL_ROOT}/..."""
    # Create staging with a footprint that has a relative 3D model reference
    lcsc = "C25804"
    staging_part = tmp_path / "staging" / lcsc
    staging_part.mkdir(parents=True)
    (staging_part / f"{lcsc}.kicad_sym").write_bytes(FIXTURE_SYM.read_bytes())
    pretty = staging_part / f"{lcsc}.pretty"
    pretty.mkdir()
    (pretty / f"{lcsc}.kicad_mod").write_text(
        f'(footprint "{lcsc}"\n'
        f'  (version 20211014)\n'
        f'  (generator pcbnew)\n'
        f'  (layer "F.Cu")\n'
        f'  (model ./{lcsc}.wrl\n'
        f'    (offset (xyz 0 0 0))\n'
        f'    (scale (xyz 1 1 1))\n'
        f'    (rotate (xyz 0 0 0))\n'
        f'  )\n'
        f')\n'
    )
    shapes = staging_part / f"{lcsc}.3dshapes"
    shapes.mkdir()
    (shapes / f"{lcsc}.wrl").write_text("#VRML V2.0 utf8\n")

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target_lib = "Caps_KSL"

    commit_to_library(
        workspace=workspace,
        lcsc=lcsc,
        staging_part=staging_part,
        target_lib=target_lib,
        edits={},
    )

    kicad_mod = workspace / target_lib / f"{target_lib}.pretty" / f"{lcsc}.kicad_mod"
    content = kicad_mod.read_text()
    assert "${KSL_ROOT}" in content
    assert target_lib in content


# ---------------------------------------------------------------------------
# Test 5: returns path that exists
# ---------------------------------------------------------------------------

def test_commit_returns_valid_existing_path(tmp_path: Path):
    staging_part = _make_staging(tmp_path / "staging", LCSC)
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    result = commit_to_library(
        workspace=workspace,
        lcsc=LCSC,
        staging_part=staging_part,
        target_lib="TestLib_KSL",
        edits={},
    )
    assert isinstance(result, Path)
    assert result.exists()
    assert result.is_dir()
