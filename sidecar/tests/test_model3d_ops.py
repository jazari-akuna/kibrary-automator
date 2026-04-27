"""Tests for model3d_ops — Task P13 (TDD).

Library structure expected:
  lib_dir/
    <lib_name>.kicad_sym
    <lib_name>.pretty/<component_name>.kicad_mod
    <lib_name>.3dshapes/<component_name>.<ext>   (optional)
"""
from __future__ import annotations

from pathlib import Path

import pytest

from kibrary_sidecar.model3d_ops import add_3d_model, replace_3d_model, set_3d_offset

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_LIB_NAME = "Resistors_KSL"
_COMP = "R_10k_0402"


def _make_lib(
    base: Path,
    lib_name: str = _LIB_NAME,
    comp: str = _COMP,
    with_3d_ext: str | None = None,
    kicad_mod_has_model: bool = False,
) -> Path:
    """Create a minimal library structure under *base*."""
    lib_dir = base / lib_name
    lib_dir.mkdir(parents=True)

    # Symbol file
    (lib_dir / f"{lib_name}.kicad_sym").write_text(
        f'(kicad_symbol_lib (version 20231120) (generator t)\n'
        f'  (symbol "{comp}" (in_bom yes) (on_board yes)\n'
        f'    (property "Reference" "R" (id 0) (at 0 0 0))\n'
        f'    (property "Value" "10k" (id 1) (at 0 0 0))\n'
        f'    (property "Footprint" "{lib_name}:{comp}" (id 2) (at 0 0 0))\n'
        f'    (property "Datasheet" "" (id 3) (at 0 0 0))\n'
        f'  )\n'
        f')\n'
    )

    # Pretty dir + .kicad_mod
    pretty = lib_dir / f"{lib_name}.pretty"
    pretty.mkdir()
    if kicad_mod_has_model:
        mod_content = (
            f'(footprint "{comp}"\n'
            f'  (version 20211014)\n'
            f'  (generator pcbnew)\n'
            f'  (layer "F.Cu")\n'
            f'  (model ${{KSL_ROOT}}/{lib_name}/{lib_name}.3dshapes/{comp}.step\n'
            f'    (offset (xyz 0 0 0))\n'
            f'    (scale (xyz 1 1 1))\n'
            f'    (rotate (xyz 0 0 0))\n'
            f'  )\n'
            f')\n'
        )
    else:
        mod_content = (
            f'(footprint "{comp}"\n'
            f'  (version 20211014)\n'
            f'  (generator pcbnew)\n'
            f'  (layer "F.Cu")\n'
            f')\n'
        )
    (pretty / f"{comp}.kicad_mod").write_text(mod_content)

    # Optional existing 3D model
    if with_3d_ext is not None:
        shapes = lib_dir / f"{lib_name}.3dshapes"
        shapes.mkdir(exist_ok=True)
        (shapes / f"{comp}{with_3d_ext}").write_bytes(b"ORIGINAL_CONTENT")

    return lib_dir


def _make_src_file(base: Path, name: str, content: bytes = b"STEP_DATA_XYZ") -> Path:
    src = base / name
    src.write_bytes(content)
    return src


# ---------------------------------------------------------------------------
# Test 1 — replace existing .step with new .step
# ---------------------------------------------------------------------------

def test_replace_existing_step_with_new_step(tmp_path: Path):
    lib_dir = _make_lib(tmp_path / "lib", with_3d_ext=".step", kicad_mod_has_model=True)
    src = _make_src_file(tmp_path, "new_model.step", b"NEW_STEP_CONTENT")

    dst = replace_3d_model(lib_dir, _COMP, src)

    shapes_dir = lib_dir / f"{_LIB_NAME}.3dshapes"
    expected = shapes_dir / f"{_COMP}.step"
    assert dst == expected
    assert expected.is_file()
    assert expected.read_bytes() == b"NEW_STEP_CONTENT"

    # Old file replaced (same extension, so same file path)
    assert list(shapes_dir.glob(f"{_COMP}.*")) == [expected]

    # .kicad_mod model path updated
    mod_text = (lib_dir / f"{_LIB_NAME}.pretty" / f"{_COMP}.kicad_mod").read_text()
    assert "${KSL_ROOT}" in mod_text
    assert f"{_COMP}.step" in mod_text


# ---------------------------------------------------------------------------
# Test 2 — replace .step with .wrl — old .step cleaned up
# ---------------------------------------------------------------------------

def test_replace_step_with_wrl_cleans_up_old_step(tmp_path: Path):
    lib_dir = _make_lib(tmp_path / "lib", with_3d_ext=".step", kicad_mod_has_model=True)
    src = _make_src_file(tmp_path, "new_model.wrl", b"#VRML V2.0 utf8\n")

    dst = replace_3d_model(lib_dir, _COMP, src)

    shapes_dir = lib_dir / f"{_LIB_NAME}.3dshapes"
    expected = shapes_dir / f"{_COMP}.wrl"
    assert dst == expected
    assert expected.is_file()

    # Old .step must be gone
    assert not (shapes_dir / f"{_COMP}.step").exists()

    # .kicad_mod updated to point at .wrl
    mod_text = (lib_dir / f"{_LIB_NAME}.pretty" / f"{_COMP}.kicad_mod").read_text()
    assert "${KSL_ROOT}" in mod_text
    assert f"{_COMP}.wrl" in mod_text


# ---------------------------------------------------------------------------
# Test 3 — add 3D model when none existed
# ---------------------------------------------------------------------------

def test_add_3d_when_none_existed(tmp_path: Path):
    # No existing 3dshapes dir; .kicad_mod has no model block
    lib_dir = _make_lib(tmp_path / "lib", with_3d_ext=None, kicad_mod_has_model=False)
    src = _make_src_file(tmp_path, "widget.step", b"FRESH_STEP")

    dst = add_3d_model(lib_dir, _COMP, src)

    shapes_dir = lib_dir / f"{_LIB_NAME}.3dshapes"
    expected = shapes_dir / f"{_COMP}.step"
    assert dst == expected
    assert expected.is_file()
    assert expected.read_bytes() == b"FRESH_STEP"

    # .kicad_mod should now have a (model ...) block
    mod_text = (lib_dir / f"{_LIB_NAME}.pretty" / f"{_COMP}.kicad_mod").read_text()
    assert "${KSL_ROOT}" in mod_text
    assert f"{_COMP}.step" in mod_text


# ---------------------------------------------------------------------------
# Test 4 — source file missing raises FileNotFoundError
# ---------------------------------------------------------------------------

def test_replace_raises_when_source_missing(tmp_path: Path):
    lib_dir = _make_lib(tmp_path / "lib")
    missing = tmp_path / "ghost.step"  # does not exist

    with pytest.raises(FileNotFoundError):
        replace_3d_model(lib_dir, _COMP, missing)


# ---------------------------------------------------------------------------
# Test 5 — target lib dir missing raises FileNotFoundError
# ---------------------------------------------------------------------------

def test_replace_raises_when_target_lib_missing(tmp_path: Path):
    lib_dir = tmp_path / "nonexistent_lib"
    src = _make_src_file(tmp_path, "model.step")

    with pytest.raises(FileNotFoundError):
        replace_3d_model(lib_dir, _COMP, src)


# ---------------------------------------------------------------------------
# Test 6 — unsupported extension rejected with ValueError
# ---------------------------------------------------------------------------

def test_invalid_source_extension_rejected(tmp_path: Path):
    lib_dir = _make_lib(tmp_path / "lib")
    src = _make_src_file(tmp_path, "model.obj")

    with pytest.raises(ValueError, match="Unsupported"):
        replace_3d_model(lib_dir, _COMP, src)


# ---------------------------------------------------------------------------
# Test 7 — set_3d_offset round-trip: offset / rotation / scale persist
# ---------------------------------------------------------------------------

def test_set_3d_offset_round_trip(tmp_path: Path):
    """Updating offset / rotation / scale via kiutils round-trips through the
    file: re-reading the kicad_mod returns the values we wrote."""
    from kiutils.footprint import Footprint

    lib_dir = _make_lib(
        tmp_path / "lib", with_3d_ext=".step", kicad_mod_has_model=True
    )

    set_3d_offset(
        lib_dir,
        _COMP,
        offset=(1.5, -2.25, 0.75),
        rotation=(0.0, 90.0, 180.0),
        scale=(1.1, 1.2, 1.3),
    )

    mod_path = lib_dir / f"{_LIB_NAME}.pretty" / f"{_COMP}.kicad_mod"
    fp = Footprint().from_file(str(mod_path))

    assert len(fp.models) == 1
    m = fp.models[0]
    assert (m.pos.X, m.pos.Y, m.pos.Z) == (1.5, -2.25, 0.75)
    assert (m.rotate.X, m.rotate.Y, m.rotate.Z) == (0.0, 90.0, 180.0)
    assert (m.scale.X, m.scale.Y, m.scale.Z) == (1.1, 1.2, 1.3)


def test_set_3d_offset_raises_when_no_model_block(tmp_path: Path):
    """No (model ...) block to update → ValueError."""
    lib_dir = _make_lib(
        tmp_path / "lib", with_3d_ext=None, kicad_mod_has_model=False
    )

    with pytest.raises(ValueError, match="no 3D model block"):
        set_3d_offset(
            lib_dir,
            _COMP,
            offset=(0, 0, 0),
            rotation=(0, 0, 0),
            scale=(1, 1, 1),
        )


def test_set_3d_offset_raises_when_kicad_mod_missing(tmp_path: Path):
    """Library exists but the component's .kicad_mod doesn't → FileNotFoundError."""
    lib_dir = _make_lib(tmp_path / "lib")
    # Remove the .kicad_mod that _make_lib created.
    mod_path = lib_dir / f"{_LIB_NAME}.pretty" / f"{_COMP}.kicad_mod"
    mod_path.unlink()

    with pytest.raises(FileNotFoundError):
        set_3d_offset(
            lib_dir,
            _COMP,
            offset=(0, 0, 0),
            rotation=(0, 0, 0),
            scale=(1, 1, 1),
        )
