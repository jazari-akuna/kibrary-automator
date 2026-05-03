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


def test_dropped_step_gets_model_block_in_kicad_mod(tmp_path: Path) -> None:
    """alpha.4-bugfix: dropping symbol + footprint (no model block) + STEP
    must add a (model ...) block to the committed .kicad_mod referencing
    ${KSL_ROOT}/<lib>/<lib>.3dshapes/<step-basename>.

    Reproduces the SnapEDA I-PEX 20525-210E-02 workflow the user reported:
    third-party footprint with no embedded 3D refs, separate STEP file,
    after drag-drop commit the in-app 3D viewer must show the chip body.
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    src_dir = tmp_path / "snapeda"
    src_dir.mkdir()
    sym = src_dir / "20525-210E-02.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())
    fp = src_dir / "I-PEX_20525-210E-02.kicad_mod"
    # Footprint with NO (model ...) block (the SnapEDA pattern).
    fp.write_text(
        '(footprint "I-PEX_20525-210E-02" (layer F.Cu)\n'
        '  (descr "")\n'
        '  (attr smd)\n'
        '  (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        ')\n'
    )
    step = src_dir / "I-PEX_20525-210E-02.step"
    step.write_bytes(b"ISO-10303-21;\nHEADER;\n")  # minimal STEP-ish

    group = {
        "name": "I-PEX_20525-210E-02",
        "symbol_path": str(sym),
        "footprint_path": str(fp),
        "model_paths": [str(step)],
        "source_dir": str(src_dir),
    }

    commit_group(workspace=workspace, group=group, target_lib="Connector_KSL")

    committed_fp = workspace / "Connector_KSL" / "Connector_KSL.pretty" / "I-PEX_20525-210E-02.kicad_mod"
    assert committed_fp.is_file()
    body = committed_fp.read_text()
    assert "(model" in body, "(model …) block was NOT added to .kicad_mod"
    assert "${KSL_ROOT}/Connector_KSL/Connector_KSL.3dshapes/I-PEX_20525-210E-02.step" in body, (
        f"(model …) block has wrong path. File contents:\n{body}"
    )

    # And the .step file itself must have landed in .3dshapes/
    committed_step = workspace / "Connector_KSL" / "Connector_KSL.3dshapes" / "I-PEX_20525-210E-02.step"
    assert committed_step.is_file()


def test_ipex_snapeda_folder_mismatched_stems(tmp_path: Path) -> None:
    """Real I-PEX 20952-024E-02 SnapEDA folder structure:
        ├── 20952-024E-02.kicad_sym          (symbol entry: 20952-024E-02)
        ├── 20952-024E-02.step               (3d basename matches sym)
        ├── how-to-import.htm                (junk → unmatched)
        └── IPEX_20952-024E-02.kicad_mod     (footprint name: IPEX_20952-024E-02)

    The symbol's Footprint property reads `IPEX_20952-024E-02` (un-prefixed,
    no `:` separator); the .kicad_mod has NO (model …) block at all. After
    drop-commit:
        - all four files belong to ONE component (folder-mode grouping)
        - .htm lands in unmatched
        - .kicad_mod is in Connector_KSL.pretty/ with name preserved
        - .step is in Connector_KSL.3dshapes/ with name preserved
        - .kicad_mod gains a (model …) block pointing at the .step
        - symbol's Footprint property auto-rewrites to Connector_KSL:IPEX_…
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    folder = tmp_path / "IPEX_20952-024E-02"
    folder.mkdir()

    sym = folder / "20952-024E-02.kicad_sym"
    sym.write_text(
        '(kicad_symbol_lib (version 20211014) (generator None)\n'
        '  (symbol "20952-024E-02" (in_bom yes) (on_board yes)\n'
        '    (property "Reference" "J" (id 0) (at 0 0 0))\n'
        '    (property "Value" "20952-024E-02" (id 1) (at 0 0 0))\n'
        '    (property "Footprint" "IPEX_20952-024E-02" (id 2) (at 0 0 0))\n'
        '    (property "Datasheet" "" (id 3) (at 0 0 0))\n'
        '  )\n'
        ')\n'
    )
    fp = folder / "IPEX_20952-024E-02.kicad_mod"
    fp.write_text(
        '(footprint "IPEX_20952-024E-02" (layer F.Cu)\n'
        '  (descr "")\n'
        '  (attr smd)\n'
        '  (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        ')\n'
    )
    step = folder / "20952-024E-02.step"
    step.write_bytes(b"ISO-10303-21;\nHEADER;\n")
    junk = folder / "how-to-import.htm"
    junk.write_text("<html>readme</html>")

    # 1. scan_paths against the folder
    scan = scan_paths([str(folder)])
    assert len(scan["folders"]) == 1
    grp = scan["folders"][0]
    assert grp["name"] == "IPEX_20952-024E-02"
    assert Path(grp["symbol_path"]).name == "20952-024E-02.kicad_sym"
    assert Path(grp["footprint_path"]).name == "IPEX_20952-024E-02.kicad_mod"
    assert len(grp["model_paths"]) == 1
    assert Path(grp["model_paths"][0]).name == "20952-024E-02.step"
    assert scan["unmatched"] == [str(junk)]
    assert scan["loose_files"] == []

    # 2. commit_group into Connector_KSL (creates new lib)
    result = commit_group(workspace=workspace, group=grp, target_lib="Connector_KSL")

    lib_dir = workspace / "Connector_KSL"
    pretty = lib_dir / "Connector_KSL.pretty"
    shapes = lib_dir / "Connector_KSL.3dshapes"

    # Files preserved with original basenames
    assert (pretty / "IPEX_20952-024E-02.kicad_mod").is_file()
    assert (shapes / "20952-024E-02.step").is_file()

    # Footprint now has (model …) block pointing at the .step via KSL_ROOT
    fp_body = (pretty / "IPEX_20952-024E-02.kicad_mod").read_text()
    assert "${KSL_ROOT}/Connector_KSL/Connector_KSL.3dshapes/20952-024E-02.step" in fp_body, (
        f"(model …) block missing or wrong path. Body:\n{fp_body}"
    )

    # Symbol's un-prefixed Footprint property auto-prefixed with target lib
    sym_body = (lib_dir / "Connector_KSL.kicad_sym").read_text()
    assert '"Connector_KSL:IPEX_20952-024E-02"' in sym_body, (
        f"Footprint property not rewritten. Symbol body:\n{sym_body}"
    )

    # Symbol entry name preserved
    assert result["component_name"] == "20952-024E-02"


def test_dropped_step_with_existing_model_block_not_duplicated(tmp_path: Path) -> None:
    """If the .kicad_mod already has a (model …) block whose path matches
    what we'd synthesize, don't duplicate it (idempotent re-commits)."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    src_dir = tmp_path / "src"
    src_dir.mkdir()
    sym = src_dir / "X.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())
    fp = src_dir / "X.kicad_mod"
    fp.write_text(
        '(footprint "X" (layer F.Cu)\n'
        '  (model ${KSL_ROOT}/Foo_KSL/Foo_KSL.3dshapes/X.step\n'
        '    (offset (xyz 0 0 0))\n'
        '    (scale (xyz 1 1 1))\n'
        '    (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n'
    )
    step = src_dir / "X.step"
    step.write_bytes(b"ISO-10303-21;\n")

    group = {
        "name": "X",
        "symbol_path": str(sym),
        "footprint_path": str(fp),
        "model_paths": [str(step)],
        "source_dir": str(src_dir),
    }

    commit_group(workspace=workspace, group=group, target_lib="Foo_KSL")
    committed_fp = workspace / "Foo_KSL" / "Foo_KSL.pretty" / "X.kicad_mod"
    body = committed_fp.read_text()
    # Exactly one (model …) block — no duplicate
    assert body.count("(model ") == 1, f"(model …) duplicated. Contents:\n{body}"


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


# ---------------------------------------------------------------------------
# Bug 1 — auto-centring the STEP body on the footprint's pad bbox
# (Wave 4 / 3d-fix-journal). _ensure_model_blocks must compute a sane default
# (offset …) so the chip body lands over the pads instead of (0,0,0) which
# leaves SnapEDA STEPs visibly off to one side.
# ---------------------------------------------------------------------------

# Real STEP shipped with the e2e fixtures; bbox via OCP is roughly
# x[-1.55,1.55] y[-1.50,1.50] z[0,1.25] → centre ≈ (0, 0, 0.625).
_UFL_STEP = (
    Path(__file__).parent.parent.parent
    / "e2e" / "fixtures" / "u_fl_hirose"
    / "U.FL_Hirose_U.FL-R-SMT-1_Vertical.step"
)


def test_dropped_step_offset_centers_body_on_pads(tmp_path: Path) -> None:
    """When a STEP is dropped onto a footprint, the auto-generated
    (model …) block must include an (offset (xyz …)) that translates the
    STEP body's bbox centre onto the centre of the footprint's pad bbox.

    Synthetic footprint: pads at (3, 4) and (7, 4) → pad bbox centre (5, 4).
    Real STEP fixture: U.FL body centred at (0, 0, ~0.625).
    Expected offset = pad_centre - step_centre ≈ (5, 4, 0).
    """
    if not _UFL_STEP.is_file():
        pytest.skip(f"e2e fixture missing: {_UFL_STEP}")

    workspace = tmp_path / "workspace"
    workspace.mkdir()

    src_dir = tmp_path / "src"
    src_dir.mkdir()
    sym = src_dir / "X.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())
    fp = src_dir / "X.kicad_mod"
    fp.write_text(
        '(footprint "X" (layer F.Cu)\n'
        '  (pad 1 smd rect (at 3 4) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        '  (pad 2 smd rect (at 7 4) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        ')\n'
    )
    step = src_dir / "X.step"
    step.write_bytes(_UFL_STEP.read_bytes())

    group = {
        "name": "X",
        "symbol_path": str(sym),
        "footprint_path": str(fp),
        "model_paths": [str(step)],
        "source_dir": str(src_dir),
    }

    commit_group(workspace=workspace, group=group, target_lib="Foo_KSL")
    committed = workspace / "Foo_KSL" / "Foo_KSL.pretty" / "X.kicad_mod"
    assert committed.is_file()

    from kiutils.footprint import Footprint as _Fp
    parsed = _Fp().from_file(str(committed))
    assert len(parsed.models) == 1, f"expected exactly one model block, got {len(parsed.models)}"
    m = parsed.models[0]
    assert m.pos is not None, "model block missing offset"
    # U.FL body centre ≈ (0, 0, 0.625); pad centre = (5, 4)
    # Expected: offset.x ≈ 5, offset.y ≈ 4, offset.z ≈ 0
    assert abs(m.pos.X - 5.0) < 0.05, f"expected offset.X≈5, got {m.pos.X}"
    assert abs(m.pos.Y - 4.0) < 0.05, f"expected offset.Y≈4, got {m.pos.Y}"
    assert abs(m.pos.Z) < 0.05, f"expected offset.Z=0, got {m.pos.Z}"


def test_dropped_step_offset_falls_back_when_step_unreadable(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """An invalid/unreadable STEP must NOT crash the commit — the (model …)
    block is still added but with offset (0,0,0) and a warning logged."""
    import logging

    workspace = tmp_path / "workspace"
    workspace.mkdir()

    src_dir = tmp_path / "src"
    src_dir.mkdir()
    sym = src_dir / "X.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())
    fp = src_dir / "X.kicad_mod"
    fp.write_text(
        '(footprint "X" (layer F.Cu)\n'
        '  (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        ')\n'
    )
    # Write garbage that is NOT a STEP file — OCP will reject, regex finds no
    # CARTESIAN_POINT entries → bbox returns None → fall through to (0,0,0).
    step = src_dir / "broken.step"
    step.write_text("not a real step file")

    group = {
        "name": "X",
        "symbol_path": str(sym),
        "footprint_path": str(fp),
        "model_paths": [str(step)],
        "source_dir": str(src_dir),
    }

    with caplog.at_level(logging.WARNING, logger="kibrary_sidecar.drop_import"):
        commit_group(workspace=workspace, group=group, target_lib="Foo_KSL")

    committed = workspace / "Foo_KSL" / "Foo_KSL.pretty" / "X.kicad_mod"
    body = committed.read_text()
    assert "(model" in body
    # Either the offset is absent (kiutils default) or all-zero — verify
    # the .step did NOT get a non-zero translation.
    from kiutils.footprint import Footprint as _Fp
    parsed = _Fp().from_file(str(committed))
    assert len(parsed.models) == 1
    m = parsed.models[0]
    assert (m.pos is None) or (
        abs(m.pos.X) < 1e-9 and abs(m.pos.Y) < 1e-9 and abs(m.pos.Z) < 1e-9
    ), f"unreadable STEP must yield offset (0,0,0); got {m.pos}"
    # And a warning must be logged
    assert any(
        "fall" in rec.message.lower() or "cannot" in rec.message.lower()
        for rec in caplog.records
    ), f"expected a warning log; got: {[r.message for r in caplog.records]}"


def test_dropped_step_offset_skips_when_existing_offset_present(tmp_path: Path) -> None:
    """If the .kicad_mod already has a (model …) block for the same path
    with its own (offset …), _ensure_model_blocks must NOT overwrite it.
    The user has manually positioned the body; we respect that."""
    if not _UFL_STEP.is_file():
        pytest.skip(f"e2e fixture missing: {_UFL_STEP}")

    workspace = tmp_path / "workspace"
    workspace.mkdir()

    src_dir = tmp_path / "src"
    src_dir.mkdir()
    sym = src_dir / "X.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())
    fp = src_dir / "X.kicad_mod"
    # Pre-existing model block with a custom offset (1,2,3); same target
    # path the auto-generator would synthesise.
    fp.write_text(
        '(footprint "X" (layer F.Cu)\n'
        '  (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        '  (model "${KSL_ROOT}/Foo_KSL/Foo_KSL.3dshapes/X.step"\n'
        '    (offset (xyz 1 2 3))\n'
        '    (scale (xyz 1 1 1))\n'
        '    (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n'
    )
    step = src_dir / "X.step"
    step.write_bytes(_UFL_STEP.read_bytes())

    group = {
        "name": "X",
        "symbol_path": str(sym),
        "footprint_path": str(fp),
        "model_paths": [str(step)],
        "source_dir": str(src_dir),
    }

    commit_group(workspace=workspace, group=group, target_lib="Foo_KSL")
    committed = workspace / "Foo_KSL" / "Foo_KSL.pretty" / "X.kicad_mod"

    from kiutils.footprint import Footprint as _Fp
    parsed = _Fp().from_file(str(committed))
    assert len(parsed.models) == 1, "must not duplicate the model block"
    m = parsed.models[0]
    assert abs(m.pos.X - 1.0) < 1e-9, f"offset.X must be preserved at 1; got {m.pos.X}"
    assert abs(m.pos.Y - 2.0) < 1e-9, f"offset.Y must be preserved at 2; got {m.pos.Y}"
    assert abs(m.pos.Z - 3.0) < 1e-9, f"offset.Z must be preserved at 3; got {m.pos.Z}"


def test_dropped_wrl_uses_zero_offset(tmp_path: Path) -> None:
    """WRL files are not parseable for solid bbox — auto-offset must
    short-circuit to (0,0,0) without attempting STEP parsing."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    src_dir = tmp_path / "src"
    src_dir.mkdir()
    sym = src_dir / "X.kicad_sym"
    sym.write_bytes(FIXTURE_SYM.read_bytes())
    fp = src_dir / "X.kicad_mod"
    fp.write_text(
        '(footprint "X" (layer F.Cu)\n'
        '  (pad 1 smd rect (at 5 5) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        ')\n'
    )
    wrl = src_dir / "X.wrl"
    wrl.write_text("#VRML V2.0 utf8\n# any content; we don't parse this\n")

    group = {
        "name": "X",
        "symbol_path": str(sym),
        "footprint_path": str(fp),
        "model_paths": [str(wrl)],
        "source_dir": str(src_dir),
    }

    commit_group(workspace=workspace, group=group, target_lib="Foo_KSL")
    committed = workspace / "Foo_KSL" / "Foo_KSL.pretty" / "X.kicad_mod"

    from kiutils.footprint import Footprint as _Fp
    parsed = _Fp().from_file(str(committed))
    assert len(parsed.models) == 1
    m = parsed.models[0]
    # Even though pads are at (5,5), WRL gets offset (0,0,0) — the user can
    # adjust manually via the positioner.
    assert (m.pos is None) or (
        abs(m.pos.X) < 1e-9 and abs(m.pos.Y) < 1e-9 and abs(m.pos.Z) < 1e-9
    ), f"WRL must yield offset (0,0,0); got {m.pos}"
