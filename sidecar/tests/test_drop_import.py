"""Tests for drop_import — drag-drop file detection + commit."""

from __future__ import annotations

from pathlib import Path

from kibrary_sidecar.drop_import import scan_paths, commit_group

FIXTURE_SYM = Path(__file__).parent / "fixtures" / "sample.kicad_sym"


def _touch(p: Path, content: str = "") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


def test_groups_three_files_with_same_stem(tmp_path: Path) -> None:
    sym = _touch(tmp_path / "R_0603.kicad_sym")
    fp = _touch(tmp_path / "R_0603.kicad_mod")
    step = _touch(tmp_path / "R_0603.step")

    result = scan_paths([str(sym), str(fp), str(step)])

    assert result["unmatched"] == []
    assert len(result["groups"]) == 1
    g = result["groups"][0]
    assert g["name"] == "R_0603"
    assert g["symbol_path"] == str(sym)
    assert g["footprint_path"] == str(fp)
    assert g["model_paths"] == [str(step)]
    assert g["source_dir"] == str(tmp_path)


def test_two_distinct_components_make_two_groups(tmp_path: Path) -> None:
    a_sym = _touch(tmp_path / "R_0603.kicad_sym")
    a_fp = _touch(tmp_path / "R_0603.kicad_mod")
    b_sym = _touch(tmp_path / "C_0805.kicad_sym")
    b_fp = _touch(tmp_path / "C_0805.kicad_mod")

    result = scan_paths([str(tmp_path)])  # drop the whole folder

    assert result["unmatched"] == []
    names = sorted(g["name"] for g in result["groups"])
    assert names == ["C_0805", "R_0603"]


def test_folder_drop_walks_recursively(tmp_path: Path) -> None:
    _touch(tmp_path / "subdir" / "U1.kicad_sym")
    _touch(tmp_path / "subdir" / "deeper" / "U1.kicad_mod")
    _touch(tmp_path / "U1.step")

    result = scan_paths([str(tmp_path)])

    assert len(result["groups"]) == 1
    g = result["groups"][0]
    assert g["name"] == "U1"
    assert g["symbol_path"] is not None
    assert g["footprint_path"] is not None
    assert len(g["model_paths"]) == 1


def test_unrecognised_extensions_go_to_unmatched(tmp_path: Path) -> None:
    sym = _touch(tmp_path / "Q1.kicad_sym")
    junk = _touch(tmp_path / "Q1.txt")
    pdf = _touch(tmp_path / "datasheet.pdf")

    result = scan_paths([str(tmp_path)])

    assert len(result["groups"]) == 1
    assert result["groups"][0]["symbol_path"] == str(sym)
    assert sorted(result["unmatched"]) == sorted([str(junk), str(pdf)])


def test_step_and_wrl_share_one_group(tmp_path: Path) -> None:
    """A part with both STEP and WRL 3D models — both land in model_paths."""
    fp = _touch(tmp_path / "LGA48.kicad_mod")
    step = _touch(tmp_path / "LGA48.step")
    wrl = _touch(tmp_path / "LGA48.wrl")

    result = scan_paths([str(tmp_path)])

    assert len(result["groups"]) == 1
    g = result["groups"][0]
    assert g["footprint_path"] == str(fp)
    assert sorted(g["model_paths"]) == sorted([str(step), str(wrl)])


def test_extension_classification_is_case_insensitive(tmp_path: Path) -> None:
    """Some downloaders emit .STEP or .Kicad_Mod."""
    fp = _touch(tmp_path / "X.KICAD_MOD")
    step = _touch(tmp_path / "X.STEP")

    result = scan_paths([str(tmp_path)])

    assert len(result["groups"]) == 1
    g = result["groups"][0]
    assert g["footprint_path"] == str(fp)
    assert g["model_paths"] == [str(step)]


def test_nonexistent_path_silently_skipped(tmp_path: Path) -> None:
    sym = _touch(tmp_path / "OK.kicad_sym")
    ghost = tmp_path / "vanished.kicad_mod"
    # don't create ghost

    result = scan_paths([str(sym), str(ghost)])

    assert len(result["groups"]) == 1
    assert result["unmatched"] == []


def test_empty_input_returns_empty_manifest() -> None:
    assert scan_paths([]) == {"groups": [], "unmatched": []}


def test_mixed_files_and_folders(tmp_path: Path) -> None:
    """User drops a folder + some loose files together — both work."""
    folder = tmp_path / "parts"
    _touch(folder / "R_0603.kicad_sym")
    _touch(folder / "R_0603.kicad_mod")
    loose = _touch(tmp_path / "C_0805.kicad_sym")

    result = scan_paths([str(folder), str(loose)])

    assert result["unmatched"] == []
    names = sorted(g["name"] for g in result["groups"])
    assert names == ["C_0805", "R_0603"]


# ---------------------------------------------------------------------------
# commit_group tests — exercise the copy-into-library path
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
    # First drop creates the lib
    commit_group(workspace=workspace, group=_build_dropped_group(tmp_path / "a", "C25804"), target_lib="Misc_KSL")
    # Second drop merges
    commit_group(workspace=workspace, group=_build_dropped_group(tmp_path / "b", "R_0603"), target_lib="Misc_KSL")

    lib_dir = workspace / "Misc_KSL"
    sym_file = lib_dir / "Misc_KSL.kicad_sym"
    assert sym_file.is_file()
    # Both footprints should be present
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

    # Source files must still exist where dropped — copy not move
    assert src_sym.is_file()
    assert src_fp.is_file()
    assert src_model.is_file()


def test_commit_group_cleans_up_staging(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    group = _build_dropped_group(tmp_path)

    commit_group(workspace=workspace, group=group, target_lib="Test_KSL")

    staging_root = workspace / ".kibrary" / "staging"
    # The DROP_<name> dir should be cleaned up after commit
    drop_dir = staging_root / "DROP_C25804"
    assert not drop_dir.exists()


def test_commit_group_rejects_empty_group(tmp_path: Path) -> None:
    import pytest

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
