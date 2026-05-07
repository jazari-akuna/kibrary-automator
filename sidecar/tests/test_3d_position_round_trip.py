"""Round-trip tests for the 3D position save → reload flow.

Bug: user reports that after editing offset/rotation/scale dials and clicking
Save, the values come back wrong when the 3D view reloads — rotation in
particular is mangled.

These tests drive the *exact* RPC pair the frontend uses
(``library.set_3d_offset`` followed by ``library.get_3d_info``) against the
real on-disk fixtures and assert byte-for-byte numeric round-trip.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from kibrary_sidecar.methods import library_get_3d_info, library_set_3d_offset

# Fixture roots — these are the .kicad_mod files the user actually loads.
_FIXTURES_ROOT = Path(__file__).resolve().parents[2] / "e2e" / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_lib(tmp_path: Path, fixture_name: str) -> tuple[Path, str]:
    """Copy ``e2e/fixtures/<fixture_name>/*.kicad_mod`` into a fresh
    ``<tmp>/TestLib/TestLib.pretty/`` so we can drive set_3d_offset+
    get_3d_info against it without touching the source tree.

    Returns ``(lib_dir, component_name)``.
    """
    src = _FIXTURES_ROOT / fixture_name
    if not src.is_dir():
        pytest.skip(f"fixture not present: {src}")

    fixtures = sorted(src.glob("*.kicad_mod"))
    if not fixtures:
        pytest.skip(f"no .kicad_mod in fixture {fixture_name}")

    fp = fixtures[0]
    component = fp.stem

    lib_dir = tmp_path / "TestLib"
    pretty = lib_dir / "TestLib.pretty"
    pretty.mkdir(parents=True)
    shutil.copy2(fp, pretty / fp.name)
    return lib_dir, component


def _round_trip(
    lib_dir: Path,
    component: str,
    offset: list[float],
    rotation: list[float],
    scale: list[float],
) -> dict:
    """Drive the public RPC pair and return the post-save get_3d_info dict."""
    library_set_3d_offset({
        "lib_dir": str(lib_dir),
        "component_name": component,
        "offset": offset,
        "rotation": rotation,
        "scale": scale,
    })
    r = library_get_3d_info({
        "lib_dir": str(lib_dir),
        "component_name": component,
    })
    return r["info"]


# ---------------------------------------------------------------------------
# Test matrix — every fixture × every realistic transform tuple.
# ---------------------------------------------------------------------------

# Representative dial inputs. Covers:
#   - identity (no edit)
#   - typical fine-tuning (1.5, 22.5, etc.)
#   - 90° rotation (cardinal, the most common dial click)
#   - high-precision values from text input
#   - small-fraction offsets (0.0001 mm — the dial's smallest step)
_TRANSFORMS = [
    pytest.param(
        [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0],
        id="identity",
    ),
    pytest.param(
        [1.5, -2.25, 0.75], [10.0, 90.0, -45.0], [1.1, 1.2, 1.3],
        id="typical-edit",
    ),
    pytest.param(
        [0.0, 0.0, 0.0], [0.0, 90.0, 0.0], [1.0, 1.0, 1.0],
        id="rotation-y-90",
    ),
    pytest.param(
        [0.0, 0.0, 0.0], [-90.0, 180.0, 90.0], [1.0, 1.0, 1.0],
        id="rotation-cardinal-mix",
    ),
    pytest.param(
        [0.4749999928, 0.0, 0.0], [22.5, -67.5, 33.5], [1.0, 1.0, 1.0],
        id="precision-from-input",
    ),
    pytest.param(
        [0.0001, 0.0001, 0.0001], [0.1, 0.1, 0.1], [1.0, 1.0, 1.0],
        id="dial-smallest-step",
    ),
]


_FIXTURES = ["u_fl_hirose", "ipex_user", "synthetic_pcb_named"]


@pytest.mark.parametrize("fixture", _FIXTURES)
@pytest.mark.parametrize("offset,rotation,scale", _TRANSFORMS)
def test_3d_position_round_trip(
    tmp_path: Path,
    fixture: str,
    offset: list[float],
    rotation: list[float],
    scale: list[float],
):
    """The exact values sent through library.set_3d_offset must come back
    unchanged from library.get_3d_info."""
    lib_dir, component = _seed_lib(tmp_path, fixture)

    info = _round_trip(lib_dir, component, offset, rotation, scale)

    assert info is not None, (
        f"library.get_3d_info returned None for {fixture} after a "
        f"successful save — the model block was not preserved by "
        f"set_3d_offset. This is the user-reported 'values not saved' bug."
    )

    # Numeric equality with epsilon. We reject sign flips, axis swaps, and
    # value rewrites — exactly the failure modes the user described.
    assert info["offset"] == pytest.approx(offset, abs=1e-9), (
        f"offset round-trip mismatch for {fixture}: "
        f"sent {offset}, got {info['offset']}"
    )
    assert info["rotation"] == pytest.approx(rotation, abs=1e-9), (
        f"rotation round-trip mismatch for {fixture}: "
        f"sent {rotation}, got {info['rotation']}"
    )
    assert info["scale"] == pytest.approx(scale, abs=1e-9), (
        f"scale round-trip mismatch for {fixture}: "
        f"sent {scale}, got {info['scale']}"
    )


# ---------------------------------------------------------------------------
# Regression — chained saves (the user's actual flow: edit, save, edit
# more, save again). Each save must build on the previous one's values
# rather than reset to defaults.
# ---------------------------------------------------------------------------


def test_3d_position_chained_saves_preserve_history(tmp_path: Path):
    """Sequential saves must each persist their own values without any
    of them overwriting or zeroing other axes."""
    lib_dir, component = _seed_lib(tmp_path, "u_fl_hirose")

    saves = [
        ([0.5, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]),
        ([0.5, 1.0, 0.0], [0.0, 90.0, 0.0], [1.0, 1.0, 1.0]),
        ([0.5, 1.0, 2.0], [45.0, 90.0, -22.5], [1.1, 1.0, 1.0]),
    ]
    for off, rot, scl in saves:
        info = _round_trip(lib_dir, component, off, rot, scl)
        assert info["offset"] == pytest.approx(off, abs=1e-9), \
            f"chained-save offset mismatch: sent {off}, got {info['offset']}"
        assert info["rotation"] == pytest.approx(rot, abs=1e-9), \
            f"chained-save rotation mismatch: sent {rot}, got {info['rotation']}"
        assert info["scale"] == pytest.approx(scl, abs=1e-9), \
            f"chained-save scale mismatch: sent {scl}, got {info['scale']}"


# ---------------------------------------------------------------------------
# Regression — _patch_model_transform must INSERT missing sub-S-exprs, not
# silently drop the override. When the source footprint's (model …) block
# omits one of (offset/scale/rotate), the live-preview renderer would
# otherwise render with the original transform (zeros) and the user's
# unsaved dial values would only "stick" once Save forced the file to
# acquire the missing block. That's the visual "chip jumps when 3D view
# reloads after save" the user reported.
# ---------------------------------------------------------------------------


def test_patch_model_transform_inserts_missing_offset():
    """Source model block has scale + rotate but NO offset. Patch must
    INSERT the offset clause so kicad-cli sees the user's override."""
    from kibrary_sidecar.render_3d import _patch_model_transform

    text = (
        '(footprint "test" (version 20241229)\n'
        '  (model "/abs/path/foo.step"\n'
        '    (scale (xyz 1 1 1))\n'
        '    (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n'
    )
    out = _patch_model_transform(text, (1.5, -2.5, 0.75), (0, 90, 0), (1, 1, 1))
    assert "(offset (xyz 1.5 -2.5 0.75))" in out, (
        f"override offset was silently dropped — output:\n{out}"
    )
    assert "(rotate (xyz 0 90 0))" in out


def test_patch_model_transform_inserts_missing_rotate():
    """Source has offset + scale, no rotate. Patch must insert rotate."""
    from kibrary_sidecar.render_3d import _patch_model_transform

    text = (
        '(footprint "test" (version 20241229)\n'
        '  (model "/abs/path/foo.step"\n'
        '    (offset (xyz 0 0 0))\n'
        '    (scale (xyz 1 1 1))\n'
        '  )\n'
        ')\n'
    )
    out = _patch_model_transform(text, (0, 0, 0), (0, 90, 0), (1, 1, 1))
    assert "(rotate (xyz 0 90 0))" in out, (
        f"override rotation was silently dropped — output:\n{out}"
    )


# ---------------------------------------------------------------------------
# Regression — model blocks WITHOUT (offset …) sub-S-expr (snapeda_offcentre).
#
# Several legacy / SnapEDA-style footprints commit a (model …) block with
# only (scale …) and (rotate …) — kiutils' Model.from_sexpr requires
# len(exp) ≥ 5 (path + 3 sub-exprs). When that's not met, get_3d_info
# returns None and the entire 3D card disappears in the UI even though
# the file IS valid KiCad. Surfaces as the user-reported bug "values
# disappear / get mangled when 3D view reloads": the first reload after
# a save lands here.
# ---------------------------------------------------------------------------


def test_get_3d_info_returns_data_for_model_block_without_offset(tmp_path: Path):
    """A footprint whose (model …) block lacks an explicit (offset …) is
    still a valid KiCad footprint. get_3d_info must return data with
    offset defaulted to (0, 0, 0), not bail to None."""
    lib_dir, component = _seed_lib(tmp_path, "snapeda_offcentre")

    info = library_get_3d_info({
        "lib_dir": str(lib_dir),
        "component_name": component,
    })["info"]

    assert info is not None, (
        "library.get_3d_info returned None for a footprint whose model "
        "block lacks an explicit (offset …). The frontend then shows "
        "'No 3D model attached' instead of the editable card. "
        "Same path the user-reported reload bug travels."
    )
    assert info["rotation"] == pytest.approx([0.0, 0.0, 0.0], abs=1e-9)
    assert info["scale"] == pytest.approx([1.0, 1.0, 1.0], abs=1e-9)
    # offset defaults to zero when the sub-S-expr is absent.
    assert info["offset"] == pytest.approx([0.0, 0.0, 0.0], abs=1e-9)
