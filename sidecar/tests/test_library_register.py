"""Tests for alpha.18 auto-register-on-commit hook in library.commit_to_library.

When the user has selected an active KiCad install (settings.kicad_install),
a successful commit must also register the library in that install's
sym-lib-table / fp-lib-table. When no install is active (headless / fresh
install / CI), the commit must still succeed — registration is best-effort.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from kibrary_sidecar import settings as st
from kibrary_sidecar.library import commit_to_library

FIXTURE_SYM = Path(__file__).parent / "fixtures" / "sample.kicad_sym"
LCSC = "C25804"


def _make_staging(base: Path, lcsc: str = LCSC) -> Path:
    staging_part = base / lcsc
    staging_part.mkdir(parents=True)
    (staging_part / f"{lcsc}.kicad_sym").write_bytes(FIXTURE_SYM.read_bytes())
    pretty = staging_part / f"{lcsc}.pretty"
    pretty.mkdir()
    (pretty / f"{lcsc}.kicad_mod").write_text(
        f'(footprint "{lcsc}"\n  (version 20211014)\n  (generator pcbnew)\n  (layer "F.Cu")\n)\n'
    )
    return staging_part


def _seed_install(tmp_path: Path) -> dict:
    """Create the lib-table parents and return an install dict pointing at them."""
    config_dir = tmp_path / "kicad-config" / "9.0"
    config_dir.mkdir(parents=True)
    sym_table = config_dir / "sym-lib-table"
    fp_table = config_dir / "fp-lib-table"
    return {
        "id": "test-9.0",
        "type": "Linux",
        "version": "9.0.8",
        "config_dir": str(config_dir),
        "sym_table": str(sym_table),
        "fp_table": str(fp_table),
        "kicad_bin": "/usr/bin/kicad",
        "eeschema_bin": "/usr/bin/eeschema",
        "pcbnew_bin": "/usr/bin/pcbnew",
    }


def test_commit_with_no_active_install_succeeds_no_register(
    tmp_path: Path, monkeypatch
):
    """No active install → commit completes; no lib-table writes happen."""
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    workspace = tmp_path / "ws"
    workspace.mkdir()
    staging = _make_staging(tmp_path / "staging")

    # Active install is None — no register call expected.
    with patch("kibrary_sidecar.kicad_register.register_library") as register_mock:
        lib_dir = commit_to_library(workspace, LCSC, staging, "Resistors_KSL", {})

    assert (lib_dir / "Resistors_KSL.kicad_sym").is_file()
    register_mock.assert_not_called()


def test_commit_with_active_install_registers_library(
    tmp_path: Path, monkeypatch
):
    """Active install → commit succeeds AND register_library is called with
    the right arguments."""
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    install = _seed_install(tmp_path)

    workspace = tmp_path / "ws"
    workspace.mkdir()
    staging = _make_staging(tmp_path / "staging")

    with patch(
        "kibrary_sidecar.kicad_install.cached_installs", return_value=[install]
    ), patch(
        "kibrary_sidecar.kicad_register.register_library"
    ) as register_mock:
        st.set_active_install("test-9.0")
        register_mock.return_value = {
            "sym_added": True, "fp_added": True, "backup_path": None
        }
        lib_dir = commit_to_library(workspace, LCSC, staging, "Resistors_KSL", {})

    assert (lib_dir / "Resistors_KSL.kicad_sym").is_file()
    register_mock.assert_called_once()
    call_args = register_mock.call_args
    # First positional: install dict
    assert call_args[0][0]["id"] == "test-9.0"
    # Second positional: lib name
    assert call_args[0][1] == "Resistors_KSL"
    # Third positional: lib_dir
    assert call_args[0][2] == lib_dir


def test_commit_swallows_register_exceptions(tmp_path: Path, monkeypatch):
    """A register failure must NOT bubble up — commit is the user's primary
    intent; the library on disk is the real outcome."""
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    install = _seed_install(tmp_path)

    workspace = tmp_path / "ws"
    workspace.mkdir()
    staging = _make_staging(tmp_path / "staging")

    with patch(
        "kibrary_sidecar.kicad_install.cached_installs", return_value=[install]
    ), patch(
        "kibrary_sidecar.kicad_register.register_library",
        side_effect=PermissionError("read-only filesystem"),
    ):
        st.set_active_install("test-9.0")
        # Must NOT raise.
        lib_dir = commit_to_library(workspace, LCSC, staging, "Resistors_KSL", {})

    assert (lib_dir / "Resistors_KSL.kicad_sym").is_file()
