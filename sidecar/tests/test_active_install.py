"""Tests for alpha.18 active-KiCad-install plumbing in settings + methods."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from kibrary_sidecar import settings as st
from kibrary_sidecar.methods import (
    kicad_detect,
    kicad_get_active,
    kicad_set_active,
)


def _seed_install(id_: str = "linux-9.0") -> dict:
    return {
        "id": id_,
        "type": "Linux",
        "version": "9.0.8",
        "config_dir": "/fake/.config/kicad/9.0",
        "sym_table": "/fake/.config/kicad/9.0/sym-lib-table",
        "fp_table": "/fake/.config/kicad/9.0/fp-lib-table",
        "kicad_bin": "/usr/bin/kicad",
        "eeschema_bin": "/usr/bin/eeschema",
        "pcbnew_bin": "/usr/bin/pcbnew",
    }


# ---------------------------------------------------------------------------
# settings.get_active_install / set_active_install
# ---------------------------------------------------------------------------

def test_get_active_returns_none_when_unset(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    assert st.get_active_install() is None


def test_set_then_get_active(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    install = _seed_install()
    with patch("kibrary_sidecar.kicad_install.cached_installs", return_value=[install]):
        st.set_active_install("linux-9.0")
        got = st.get_active_install()
    assert got is not None
    assert got["id"] == "linux-9.0"


def test_get_active_returns_none_when_id_no_longer_exists(tmp_path: Path, monkeypatch):
    """Persisted id maps to nothing (KiCad uninstalled between sessions)."""
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    st.set_active_install("ghost-id")
    with patch("kibrary_sidecar.kicad_install.cached_installs", return_value=[]):
        assert st.get_active_install() is None


def test_set_active_clear_with_none(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    st.set_active_install("linux-9.0")
    st.set_active_install(None)
    assert st.read_settings()["kicad_install"] is None


# ---------------------------------------------------------------------------
# kicad.detect / kicad.get_active / kicad.set_active RPCs
# ---------------------------------------------------------------------------

def test_detect_auto_picks_first_install_when_none_active(
    tmp_path: Path, monkeypatch
):
    """Fresh install: settings has no kicad_install, detect persists the
    first detected install's id."""
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    installs = [_seed_install("linux-9.0"), _seed_install("flatpak-9.0")]
    with patch("kibrary_sidecar.kicad_install.cached_installs", return_value=installs):
        r = kicad_detect({})
    assert r["installs"] == installs
    assert r["active"] == "linux-9.0"
    # Persisted to settings
    assert st.read_settings()["kicad_install"] == "linux-9.0"


def test_detect_keeps_existing_active(tmp_path: Path, monkeypatch):
    """Subsequent detect calls must not overwrite a user-chosen install."""
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    installs = [_seed_install("linux-9.0"), _seed_install("flatpak-9.0")]
    with patch("kibrary_sidecar.kicad_install.cached_installs", return_value=installs):
        # User had previously picked the flatpak install.
        st.set_active_install("flatpak-9.0")
        r = kicad_detect({})
    assert r["active"] == "flatpak-9.0"


def test_detect_clears_stale_active_then_repicks(tmp_path: Path, monkeypatch):
    """If the persisted id no longer matches any detected install, detect
    should clear it and auto-pick the first available."""
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    st.set_active_install("ghost-id")
    installs = [_seed_install("linux-9.0")]
    with patch("kibrary_sidecar.kicad_install.cached_installs", return_value=installs):
        r = kicad_detect({})
    assert r["active"] == "linux-9.0"


def test_detect_no_installs_returns_none_active(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    with patch("kibrary_sidecar.kicad_install.cached_installs", return_value=[]):
        r = kicad_detect({})
    assert r["installs"] == []
    assert r["active"] is None


def test_get_active_rpc(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    install = _seed_install()
    with patch("kibrary_sidecar.kicad_install.cached_installs", return_value=[install]):
        st.set_active_install("linux-9.0")
        r = kicad_get_active({})
    assert r["install"]["id"] == "linux-9.0"


def test_set_active_rpc(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(st, "settings_path", lambda: tmp_path / "settings.json")
    r = kicad_set_active({"id": "linux-9.0"})
    assert r["active"] == "linux-9.0"
    assert st.read_settings()["kicad_install"] == "linux-9.0"
