"""Tests for kicad_install.py – KiCad install detection, cross-OS.

Strategy
--------
We monkeypatch:
  - sys.platform          → simulate the target OS
  - Path.home()           → redirect to tmp_path so no real FS is touched
  - os.environ (APPDATA, XDG_CONFIG_HOME, PROGRAMFILES) as needed
  - shutil.which          → return None (no real PATH binaries expected)

We *create real files* inside tmp_path so that Path.is_dir() / Path.is_file()
work naturally without needing to patch them.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import kibrary_sidecar.kicad_install as ki


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_kicad_config(base: Path, version: str) -> Path:
    """Create a minimal KiCad config dir with both table files."""
    vdir = base / version
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "sym-lib-table").write_text("(sym_lib_table)")
    (vdir / "fp-lib-table").write_text("(fp_lib_table)")
    return vdir


# ---------------------------------------------------------------------------
# Linux Flatpak
# ---------------------------------------------------------------------------

def test_detect_linux_flatpak_install(tmp_path: Path, monkeypatch):
    flatpak_base = (
        tmp_path / ".var" / "app" / "org.kicad.KiCad" / "config" / "kicad"
    )
    _make_kicad_config(flatpak_base, "9.0")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    installs = ki.detect_installs()

    assert len(installs) == 1
    inst = installs[0]
    assert inst["id"] == "flatpak-9.0"
    assert inst["type"] == "flatpak"
    assert inst["version"] == "9.0"
    assert inst["config_dir"] == str(flatpak_base / "9.0")
    assert inst["sym_table"] == str(flatpak_base / "9.0" / "sym-lib-table")
    assert inst["fp_table"] == str(flatpak_base / "9.0" / "fp-lib-table")
    assert "eeschema" in inst["eeschema_bin"]
    assert "org.kicad.KiCad" in inst["eeschema_bin"]
    assert "pcbnew" in inst["pcbnew_bin"]
    assert "org.kicad.KiCad" in inst["pcbnew_bin"]


# ---------------------------------------------------------------------------
# Linux regular
# ---------------------------------------------------------------------------

def test_detect_linux_regular_install(tmp_path: Path, monkeypatch):
    regular_base = tmp_path / ".config" / "kicad"
    _make_kicad_config(regular_base, "8.0")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    installs = ki.detect_installs()

    assert len(installs) == 1
    inst = installs[0]
    assert inst["id"] == "linux-8.0"
    assert inst["type"] == "linux"
    assert inst["version"] == "8.0"
    assert inst["config_dir"] == str(regular_base / "8.0")
    assert inst["sym_table"] == str(regular_base / "8.0" / "sym-lib-table")
    assert inst["fp_table"] == str(regular_base / "8.0" / "fp-lib-table")
    # shutil.which returns None → bin fields should be None
    assert inst["eeschema_bin"] is None
    assert inst["pcbnew_bin"] is None


# ---------------------------------------------------------------------------
# macOS
# ---------------------------------------------------------------------------

def test_detect_macos_install(tmp_path: Path, monkeypatch):
    mac_base = tmp_path / "Library" / "Preferences" / "kicad"
    _make_kicad_config(mac_base, "9.0")

    # macOS .app bundle binaries - simulate them existing
    app_macos = tmp_path / "Applications" / "KiCad" / "KiCad.app" / "Contents" / "MacOS"
    app_macos.mkdir(parents=True, exist_ok=True)
    (app_macos / "eeschema").write_text("")
    (app_macos / "pcbnew").write_text("")
    (app_macos / "kicad").write_text("")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "darwin")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    # Patch the hardcoded /Applications path in the module
    fake_app_macos = app_macos
    original_detect = ki._detect_macos

    def _patched_detect_macos():
        results = []
        base = Path.home() / "Library" / "Preferences" / "kicad"
        for version in ki._version_dirs(base):
            config_dir = base / version
            sym = config_dir / "sym-lib-table"
            fp = config_dir / "fp-lib-table"
            if not (sym.is_file() and fp.is_file()):
                continue

            def _mac_bin(name: str, _app=fake_app_macos) -> str | None:
                p = _app / name
                return str(p) if p.is_file() else None

            results.append(
                ki._make_install(
                    install_type="macos",
                    version=version,
                    config_dir=config_dir,
                    kicad_bin=_mac_bin("kicad"),
                    eeschema_bin=_mac_bin("eeschema"),
                    pcbnew_bin=_mac_bin("pcbnew"),
                )
            )
        return results

    monkeypatch.setattr(ki, "_detect_macos", _patched_detect_macos)

    installs = ki.detect_installs()

    assert len(installs) == 1
    inst = installs[0]
    assert inst["id"] == "macos-9.0"
    assert inst["type"] == "macos"
    assert inst["version"] == "9.0"
    assert inst["config_dir"] == str(mac_base / "9.0")
    assert inst["sym_table"] == str(mac_base / "9.0" / "sym-lib-table")
    assert inst["fp_table"] == str(mac_base / "9.0" / "fp-lib-table")
    assert "eeschema" in inst["eeschema_bin"]
    assert "pcbnew" in inst["pcbnew_bin"]


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------

def test_detect_windows_install(tmp_path: Path, monkeypatch):
    appdata = tmp_path / "AppData" / "Roaming"
    appdata.mkdir(parents=True, exist_ok=True)
    win_base = appdata / "kicad"
    _make_kicad_config(win_base, "9.0")

    prog_files = tmp_path / "Program Files"
    bin_dir = prog_files / "KiCad" / "9.0" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    (bin_dir / "eeschema.exe").write_text("")
    (bin_dir / "pcbnew.exe").write_text("")
    (bin_dir / "kicad.exe").write_text("")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "win32")
    monkeypatch.setenv("APPDATA", str(appdata))
    monkeypatch.setenv("PROGRAMFILES", str(prog_files))
    monkeypatch.setattr("shutil.which", lambda _name: None)

    installs = ki.detect_installs()

    assert len(installs) == 1
    inst = installs[0]
    assert inst["id"] == "windows-9.0"
    assert inst["type"] == "windows"
    assert inst["version"] == "9.0"
    assert inst["config_dir"] == str(win_base / "9.0")
    assert inst["sym_table"] == str(win_base / "9.0" / "sym-lib-table")
    assert inst["fp_table"] == str(win_base / "9.0" / "fp-lib-table")
    assert inst["eeschema_bin"].endswith("eeschema.exe")
    assert inst["pcbnew_bin"].endswith("pcbnew.exe")


# ---------------------------------------------------------------------------
# Empty / no installs
# ---------------------------------------------------------------------------

def test_detect_returns_empty_when_no_installs(tmp_path: Path, monkeypatch):
    # Home dir exists but has no KiCad config under it
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    installs = ki.detect_installs()
    assert installs == []


# ---------------------------------------------------------------------------
# Cache round-trip
# ---------------------------------------------------------------------------

def test_cache_writes_and_reads_back(tmp_path: Path, monkeypatch):
    """refresh_cache() writes JSON; cached_installs() reads it back."""
    # Set up a Linux regular install so detect_installs() returns something
    regular_base = tmp_path / ".config" / "kicad"
    _make_kicad_config(regular_base, "9.0")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    # XDG_CONFIG_HOME → tmp_path/.config so the cache lands in tmp_path
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))

    result = ki.refresh_cache()
    assert len(result) == 1
    assert result[0]["version"] == "9.0"

    # The JSON file must exist and be valid
    cache_file = ki._cache_path()
    assert cache_file.is_file()
    raw = json.loads(cache_file.read_text())
    assert "written_at" in raw
    assert "installs" in raw
    assert raw["installs"][0]["id"] == "linux-9.0"

    # cached_installs() should return the same data without re-scanning
    cached = ki.cached_installs()
    assert len(cached) == 1
    assert cached[0]["id"] == "linux-9.0"


def test_cache_refreshes_when_stale(tmp_path: Path, monkeypatch):
    """cached_installs() triggers a rescan when the cache is older than 24 h."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))

    # Write a stale cache manually (written_at = 48 h ago)
    stale_payload = {
        "written_at": time.time() - 48 * 3600,
        "installs": [{"id": "old-entry"}],
    }
    cache_file = ki._cache_path()
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(stale_payload))

    # No actual KiCad installs in tmp_path → detect returns []
    result = ki.cached_installs()
    assert result == []  # fresh scan, not the stale "old-entry"

    # Cache file should now be fresh
    raw = json.loads(cache_file.read_text())
    assert time.time() - raw["written_at"] < 5  # written very recently


def test_detect_linux_both_flatpak_and_regular(tmp_path: Path, monkeypatch):
    """When both Flatpak and regular configs exist, both appear in results."""
    flatpak_base = (
        tmp_path / ".var" / "app" / "org.kicad.KiCad" / "config" / "kicad"
    )
    _make_kicad_config(flatpak_base, "9.0")

    regular_base = tmp_path / ".config" / "kicad"
    _make_kicad_config(regular_base, "8.0")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    installs = ki.detect_installs()
    ids = {i["id"] for i in installs}
    assert "flatpak-9.0" in ids
    assert "linux-8.0" in ids
    assert len(installs) == 2
