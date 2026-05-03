"""Tests for drop_import — drag-drop file detection + commit.

alpha.3: scan_paths now returns {folders, loose_files, unmatched}
matching the user's spec ("a dropped folder = one component; loose
files attach to the last component"). The frontend merges loose_files
into the last existing component (or creates one if none).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kibrary_sidecar.drop_import import scan_paths, commit_group

FIXTURE_SYM = Path(__file__).parent / "fixtures" / "sample.kicad_sym"


def _touch(p: Path, content: str = "") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


# ---------------------------------------------------------------------------
# scan_paths — folders mode
# ---------------------------------------------------------------------------


def test_folder_drop_groups_all_files_into_one_component(tmp_path: Path) -> None:
    folder = tmp_path / "R_0603"
    _touch(folder / "schematic.kicad_sym")
    _touch(folder / "land_pattern.kicad_mod")
    _touch(folder / "model.step")

    result = scan_paths([str(folder)])

    assert result["loose_files"] == []
    assert result["unmatched"] == []
    assert len(result["folders"]) == 1
    g = result["folders"][0]
    # Folder name becomes component name — NOT the per-file stem.
    assert g["name"] == "R_0603"
    assert g["symbol_path"] == str(folder / "schematic.kicad_sym")
    assert g["footprint_path"] == str(folder / "land_pattern.kicad_mod")
    assert g["model_paths"] == [str(folder / "model.step")]


def test_two_folders_become_two_components(tmp_path: Path) -> None:
    a = tmp_path / "R_0603"
    b = tmp_path / "C_0805"
    _touch(a / "x.kicad_sym")
    _touch(a / "x.kicad_mod")
    _touch(b / "y.kicad_sym")
    _touch(b / "y.kicad_mod")

    result = scan_paths([str(a), str(b)])

    names = sorted(g["name"] for g in result["folders"])
    assert names == ["C_0805", "R_0603"]
    assert result["loose_files"] == []


def test_subfolders_each_become_own_component(tmp_path: Path) -> None:
    """A folder containing subfolders treats each subfolder as its own group."""
    parent = tmp_path / "parts"
    _touch(parent / "TopLevel.kicad_sym")
    _touch(parent / "TopLevel.kicad_mod")
    _touch(parent / "subA" / "ChildA.kicad_sym")
    _touch(parent / "subA" / "ChildA.kicad_mod")
    _touch(parent / "subB" / "ChildB.step")

    result = scan_paths([str(parent)])

    names = sorted(g["name"] for g in result["folders"])
    assert names == ["parts", "subA", "subB"]


def test_unrecognised_in_folder_goes_to_unmatched(tmp_path: Path) -> None:
    folder = tmp_path / "X"
    _touch(folder / "X.kicad_sym")
    junk = _touch(folder / "X.txt")
    pdf = _touch(folder / "datasheet.pdf")

    result = scan_paths([str(folder)])

    assert len(result["folders"]) == 1
    assert sorted(result["unmatched"]) == sorted([str(junk), str(pdf)])


def test_folder_extension_classification_case_insensitive(tmp_path: Path) -> None:
    folder = tmp_path / "Y"
    _touch(folder / "Y.KICAD_SYM")
    _touch(folder / "Y.KICAD_MOD")
    _touch(folder / "Y.STEP")
    _touch(folder / "Y.WRL")

    result = scan_paths([str(folder)])

    assert len(result["folders"]) == 1
    g = result["folders"][0]
    assert g["symbol_path"] is not None
    assert g["footprint_path"] is not None
    assert len(g["model_paths"]) == 2


# ---------------------------------------------------------------------------
# scan_paths — loose files mode
# ---------------------------------------------------------------------------


def test_loose_files_returned_separately_from_folders(tmp_path: Path) -> None:
    sym = _touch(tmp_path / "Q1.kicad_sym")
    fp = _touch(tmp_path / "Q1.kicad_mod")

    result = scan_paths([str(sym), str(fp)])

    assert result["folders"] == []
    assert result["unmatched"] == []
    kinds = sorted(f["kind"] for f in result["loose_files"])
    assert kinds == ["footprint", "symbol"]


def test_loose_file_unrecognised_extension_goes_to_unmatched(tmp_path: Path) -> None:
    sym = _touch(tmp_path / "Q1.kicad_sym")
    junk = _touch(tmp_path / "notes.txt")

    result = scan_paths([str(sym), str(junk)])

    assert len(result["loose_files"]) == 1
    assert result["loose_files"][0]["kind"] == "symbol"
    assert result["unmatched"] == [str(junk)]


def test_mixed_folder_plus_loose_files(tmp_path: Path) -> None:
    """Drop a folder AND a loose file in the same gesture."""
    folder = tmp_path / "Folder"
    _touch(folder / "F.kicad_sym")
    _touch(folder / "F.kicad_mod")
    loose = _touch(tmp_path / "extra.step")

    result = scan_paths([str(folder), str(loose)])

    assert len(result["folders"]) == 1
    assert result["folders"][0]["name"] == "Folder"
    assert len(result["loose_files"]) == 1
    assert result["loose_files"][0]["kind"] == "model"


def test_loose_file_order_is_preserved(tmp_path: Path) -> None:
    """Sequential-association rule needs stable order."""
    a = _touch(tmp_path / "a.kicad_sym")
    b = _touch(tmp_path / "b.kicad_mod")
    c = _touch(tmp_path / "c.step")

    result = scan_paths([str(a), str(b), str(c)])

    paths = [f["path"] for f in result["loose_files"]]
    assert paths == [str(a), str(b), str(c)]


def test_nonexistent_path_silently_skipped(tmp_path: Path) -> None:
    sym = _touch(tmp_path / "OK.kicad_sym")
    ghost = tmp_path / "vanished.kicad_mod"
    # don't create ghost

    result = scan_paths([str(sym), str(ghost)])

    assert len(result["loose_files"]) == 1
    assert result["unmatched"] == []
    assert result["folders"] == []


def test_empty_input_returns_empty_manifest() -> None:
    assert scan_paths([]) == {"folders": [], "loose_files": [], "unmatched": []}


# ---------------------------------------------------------------------------
# commit_group — exercise the copy-into-library path
# ---------------------------------------------------------------------------


def _build_dropped_group(tmp_path: Path, name: str = "C25804") -> dict:
    """Lay out a dropped trio (sym + footprint + 3D) on disk."""
    src_dir = tmp_path / "downloads"
    src_dir.mkdir(parents=True, exist_ok=True)
    sym = src_dir / f"{name}.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())
    fp = src_dir / f"{name}.kicad_mod"
    fp.write_text(
        f'(footprint "{name}"\n  (version 20211014)\n  (generator pcbnew)\n  (layer "F.Cu")\n)\n'
    )
    model = src_dir / f"{name}.wrl"
    model.write_text("#VRML V2.0 utf8\n")
    return {
        "name": name,
        "symbol_path": str(sym),
        "footprint_path": str(fp),
        "model_paths": [str(model)],
        "source_dir": str(src_dir),
    }


def test_commit_group_creates_new_library(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    group = _build_dropped_group(tmp_path)

    result = commit_group(
        workspace=workspace,
        group=group,
        target_lib="Capacitors_KSL",
    )

    lib_dir = workspace / "Capacitors_KSL"
    assert lib_dir.is_dir()
    assert (lib_dir / "Capacitors_KSL.kicad_sym").is_file()
    assert (lib_dir / "Capacitors_KSL.pretty").is_dir()
    assert (lib_dir / "Capacitors_KSL.3dshapes").is_dir()
    assert result["target_lib"] == "Capacitors_KSL"
    assert result["committed_path"] == str(lib_dir)
    # The fixture symbol's entryName is "C25804"
    assert result["component_name"] == "C25804"


def test_commit_group_merges_into_existing_library(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    commit_group(workspace=workspace, group=_build_dropped_group(tmp_path / "a", "C25804"), target_lib="Misc_KSL")
    commit_group(workspace=workspace, group=_build_dropped_group(tmp_path / "b", "R_0603"), target_lib="Misc_KSL")

    lib_dir = workspace / "Misc_KSL"
    sym_file = lib_dir / "Misc_KSL.kicad_sym"
    assert sym_file.is_file()
    pretty = lib_dir / "Misc_KSL.pretty"
    fps = sorted(p.name for p in pretty.glob("*.kicad_mod"))
    assert "C25804.kicad_mod" in fps and "R_0603.kicad_mod" in fps


def test_commit_group_leaves_source_files_untouched(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    group = _build_dropped_group(tmp_path)
    src_sym = Path(group["symbol_path"])
    src_fp = Path(group["footprint_path"])
    src_model = Path(group["model_paths"][0])

    commit_group(workspace=workspace, group=group, target_lib="Test_KSL")

    assert src_sym.is_file()
    assert src_fp.is_file()
    assert src_model.is_file()


def test_commit_group_cleans_up_staging(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    group = _build_dropped_group(tmp_path)

    commit_group(workspace=workspace, group=group, target_lib="Test_KSL")

    drop_dir = workspace / ".kibrary" / "staging" / "DROP_C25804"
    assert not drop_dir.exists()


def test_commit_group_rejects_empty_group(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    group = {
        "name": "OnlyModel",
        "symbol_path": None,
        "footprint_path": None,
        "model_paths": [str(_touch(tmp_path / "x.step"))],
        "source_dir": str(tmp_path),
    }
    with pytest.raises(ValueError):
        commit_group(workspace=workspace, group=group, target_lib="Whatever_KSL")


def test_commit_footprint_only_into_existing_library(tmp_path: Path) -> None:
    """alpha.3-bugfix: drop a .kicad_mod into an existing lib that already
    has a symbol referencing it. Used to crash inside _merge_into reading a
    non-existent <lcsc>.kicad_sym; the .kicad_mod was silently dropped on
    the floor and the user saw 'No .kicad_mod could be matched'.
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    # Pre-populate a library with one component
    commit_group(
        workspace=workspace,
        group=_build_dropped_group(tmp_path / "first", "Existing_Sym"),
        target_lib="Connector_KSL",
    )

    # Now drop ONLY a footprint with a different stem
    fp_only = tmp_path / "drop_dir"
    fp_only.mkdir()
    fp_path = fp_only / "IPEX_20952-024E-02.kicad_mod"
    fp_path.write_text(
        '(footprint "IPEX_20952-024E-02"\n  (layer "F.Cu")\n)\n'
    )
    group = {
        "name": "IPEX_20952-024E-02",
        "symbol_path": None,
        "footprint_path": str(fp_path),
        "model_paths": [],
        "source_dir": str(fp_only),
    }
    result = commit_group(workspace=workspace, group=group, target_lib="Connector_KSL")

    pretty = workspace / "Connector_KSL" / "Connector_KSL.pretty"
    assert (pretty / "IPEX_20952-024E-02.kicad_mod").is_file(), (
        "footprint-only drop must land in .pretty/ (regression: was silently dropped)"
    )
    assert result["target_lib"] == "Connector_KSL"


def test_unprefixed_footprint_value_gets_target_lib_prefix(tmp_path: Path) -> None:
    """alpha.3-bugfix: a symbol with Footprint property like 'IPEX_X' (no
    library prefix) should auto-rewrite to 'Lib:IPEX_X' if the matching
    .kicad_mod lives in the lib's .pretty dir. Without this the preview
    matcher reports 'No .kicad_mod could be matched'.
    """
    from kibrary_sidecar.library import _update_symbol_footprint_refs

    lib_dir = tmp_path / "Connector_KSL"
    lib_dir.mkdir()
    pretty = lib_dir / "Connector_KSL.pretty"
    pretty.mkdir()
    (pretty / "IPEX_20952-024E-02.kicad_mod").write_text('(footprint "IPEX_20952-024E-02")\n')

    sym_file = lib_dir / "Connector_KSL.kicad_sym"
    sym_file.write_text(
        '(kicad_symbol_lib (version 20211014) (generator None)\n'
        '  (symbol "20952-024E-02" (in_bom yes) (on_board yes)\n'
        '    (property "Reference" "J" (id 0) (at 0 0 0))\n'
        '    (property "Value" "20952-024E-02" (id 1) (at 0 0 0))\n'
        '    (property "Footprint" "IPEX_20952-024E-02" (id 2) (at 0 0 0))\n'
        '    (property "Datasheet" "" (id 3) (at 0 0 0))\n'
        '  )\n'
        ')\n'
    )

    _update_symbol_footprint_refs(sym_file, "Connector_KSL")

    contents = sym_file.read_text()
    assert '"Connector_KSL:IPEX_20952-024E-02"' in contents


def test_unprefixed_footprint_without_matching_file_left_alone(tmp_path: Path) -> None:
    """Don't corrupt symbols whose Footprint property is a comment / external ref."""
    from kibrary_sidecar.library import _update_symbol_footprint_refs

    lib_dir = tmp_path / "Foo_KSL"
    lib_dir.mkdir()
    pretty = lib_dir / "Foo_KSL.pretty"
    pretty.mkdir()
    # Different footprint name in pretty than in symbol
    (pretty / "OTHER.kicad_mod").write_text('(footprint "OTHER")\n')

    sym_file = lib_dir / "Foo_KSL.kicad_sym"
    sym_file.write_text(
        '(kicad_symbol_lib (version 20211014) (generator None)\n'
        '  (symbol "X" (in_bom yes) (on_board yes)\n'
        '    (property "Reference" "X" (id 0) (at 0 0 0))\n'
        '    (property "Value" "X" (id 1) (at 0 0 0))\n'
        '    (property "Footprint" "see_datasheet_p3" (id 2) (at 0 0 0))\n'
        '    (property "Datasheet" "" (id 3) (at 0 0 0))\n'
        '  )\n'
        ')\n'
    )

    _update_symbol_footprint_refs(sym_file, "Foo_KSL")

    contents = sym_file.read_text()
    assert '"see_datasheet_p3"' in contents, "must not corrupt orphan-style refs"
    assert '"Foo_KSL:see_datasheet_p3"' not in contents
