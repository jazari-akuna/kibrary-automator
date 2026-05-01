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
    # Flatpak bins are argv-style lists so callers can spawn them directly.
    assert inst["kicad_bin"] == [
        "flatpak", "run", "--command=kicad", "org.kicad.KiCad"
    ]
    assert inst["eeschema_bin"] == [
        "flatpak", "run", "--command=eeschema", "org.kicad.KiCad"
    ]
    assert inst["pcbnew_bin"] == [
        "flatpak", "run", "--command=pcbnew", "org.kicad.KiCad"
    ]


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


# ---------------------------------------------------------------------------
# register_custom_install
# ---------------------------------------------------------------------------

def _fake_kicad_cli(tmp_path: Path, name: str = "kicad-cli") -> Path:
    """Drop a fake executable file at tmp_path/<name> with mode 755."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    p = tmp_path / name
    p.write_text("#!/bin/sh\necho fake\n")
    p.chmod(0o755)
    return p


def _isolate_custom_dirs(tmp_path: Path, monkeypatch):
    """Redirect both the cache and custom-install JSON files into tmp_path."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))


def _mock_subprocess_kicad_version(monkeypatch, output: str = "KiCad version 9.0.5"):
    """Make subprocess.run return a fake kicad-cli --version success."""
    class _Proc:
        def __init__(self, stdout: str):
            self.stdout = stdout
            self.stderr = ""
            self.returncode = 0

    def _fake_run(cmd, **kwargs):
        return _Proc(output)

    monkeypatch.setattr("kibrary_sidecar.kicad_install.subprocess.run", _fake_run)


def test_register_custom_install_success(tmp_path: Path, monkeypatch):
    """Happy path: pick a kicad-cli binary, get a custom install dict back."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    fake_cli = _fake_kicad_cli(tmp_path, "kicad-cli")
    _mock_subprocess_kicad_version(monkeypatch, "KiCad version 9.0.5")

    result = ki.register_custom_install(fake_cli)

    install = result["install"]
    assert install["type"] == "custom"
    assert install["version"] == "9.0"
    assert install["kicad_cli_bin"] == str(fake_cli)
    # Companion `kicad` doesn't exist in tmp_path, so kicad_bin is None.
    assert install["kicad_bin"] is None
    assert install["id"].startswith("custom-")

    # `all_installs` is the merged list — must contain our new custom entry.
    ids = {i["id"] for i in result["all_installs"]}
    assert install["id"] in ids


def test_register_custom_install_finds_companion_kicad(tmp_path: Path, monkeypatch):
    """If `kicad` is next to `kicad-cli`, the install dict picks it up."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    fake_cli = _fake_kicad_cli(tmp_path, "kicad-cli")
    fake_kicad = _fake_kicad_cli(tmp_path, "kicad")
    _mock_subprocess_kicad_version(monkeypatch, "KiCad version 9.0.5")

    result = ki.register_custom_install(fake_cli)

    assert result["install"]["kicad_bin"] == str(fake_kicad)
    assert result["install"]["kicad_cli_bin"] == str(fake_cli)


def test_register_custom_install_rejects_non_kicad_binary(tmp_path: Path, monkeypatch):
    """A binary whose --version doesn't mention KiCad gets rejected with the
    bogus output included in the error message."""
    _isolate_custom_dirs(tmp_path, monkeypatch)

    fake_cli = _fake_kicad_cli(tmp_path, "python3")
    _mock_subprocess_kicad_version(monkeypatch, "Python 3.12.0")

    with pytest.raises(ValueError) as exc_info:
        ki.register_custom_install(fake_cli)
    assert "Python 3.12.0" in str(exc_info.value)


def test_register_custom_install_rejects_missing_file(tmp_path: Path, monkeypatch):
    """A path that doesn't exist on disk raises FileNotFoundError."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    bogus = tmp_path / "nonexistent" / "kicad-cli"
    with pytest.raises(FileNotFoundError):
        ki.register_custom_install(bogus)


def test_register_custom_install_rejects_non_executable(tmp_path: Path, monkeypatch):
    """A file that exists but isn't executable raises PermissionError."""
    _isolate_custom_dirs(tmp_path, monkeypatch)

    p = tmp_path / "kicad-cli"
    p.write_text("not-executable")
    p.chmod(0o644)

    with pytest.raises(PermissionError):
        ki.register_custom_install(p)


def test_register_custom_install_persists_across_reload(tmp_path: Path, monkeypatch):
    """After registration, cached_installs() includes the custom entry even
    after the auto-detect cache is dropped."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    fake_cli = _fake_kicad_cli(tmp_path, "kicad-cli")
    _mock_subprocess_kicad_version(monkeypatch, "KiCad version 9.0.5")

    ki.register_custom_install(fake_cli)

    # Drop the auto-detect cache so cached_installs() takes the
    # "no cache → refresh" branch — custom installs must survive that.
    cache_file = ki._cache_path()
    if cache_file.is_file():
        cache_file.unlink()

    installs = ki.cached_installs()
    custom_entries = [i for i in installs if i.get("type") == "custom"]
    assert len(custom_entries) == 1
    assert custom_entries[0]["kicad_cli_bin"] == str(fake_cli)


def test_register_custom_install_replaces_same_path(tmp_path: Path, monkeypatch):
    """Registering the same binary twice must not produce duplicate entries."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    fake_cli = _fake_kicad_cli(tmp_path, "kicad-cli")
    _mock_subprocess_kicad_version(monkeypatch, "KiCad version 9.0.5")

    ki.register_custom_install(fake_cli)
    result = ki.register_custom_install(fake_cli)

    custom_entries = [i for i in result["all_installs"] if i.get("type") == "custom"]
    assert len(custom_entries) == 1
    # And the persisted file holds exactly one entry too.
    persisted = ki._read_custom_installs()
    assert len(persisted) == 1
    assert persisted[0]["kicad_cli_bin"] == str(fake_cli)


def test_register_custom_install_two_different_paths_coexist(tmp_path: Path, monkeypatch):
    """Two distinct binaries with the same version get unique ids (sha1
    fallback) and both appear in all_installs."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    a_dir = tmp_path / "a"
    b_dir = tmp_path / "b"
    a_dir.mkdir()
    b_dir.mkdir()
    cli_a = _fake_kicad_cli(a_dir, "kicad-cli")
    cli_b = _fake_kicad_cli(b_dir, "kicad-cli")
    _mock_subprocess_kicad_version(monkeypatch, "KiCad version 9.0.5")

    ki.register_custom_install(cli_a)
    result = ki.register_custom_install(cli_b)

    custom_entries = [i for i in result["all_installs"] if i.get("type") == "custom"]
    assert len(custom_entries) == 2
    ids = {c["id"] for c in custom_entries}
    assert len(ids) == 2  # distinct ids
    paths = {c["kicad_cli_bin"] for c in custom_entries}
    assert paths == {str(cli_a), str(cli_b)}


def test_register_custom_install_accepts_kicad_launcher(tmp_path: Path, monkeypatch):
    """Picking the `kicad` launcher (not kicad-cli) populates kicad_bin and
    looks for kicad-cli as the companion."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    fake_kicad = _fake_kicad_cli(tmp_path, "kicad")
    fake_cli = _fake_kicad_cli(tmp_path, "kicad-cli")
    _mock_subprocess_kicad_version(monkeypatch, "KiCad 9.0.5 (release build)")

    result = ki.register_custom_install(fake_kicad)

    assert result["install"]["kicad_bin"] == str(fake_kicad)
    assert result["install"]["kicad_cli_bin"] == str(fake_cli)


def test_register_custom_install_uses_system_env(tmp_path: Path, monkeypatch):
    """The probe must invoke subprocess.run with the scrubbed env so the
    PyInstaller LD_LIBRARY_PATH leak (alpha.21) doesn't reappear."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    fake_cli = _fake_kicad_cli(tmp_path, "kicad-cli")

    captured = {}

    class _Proc:
        stdout = "KiCad version 9.0.5"
        stderr = ""
        returncode = 0

    def _fake_run(cmd, **kwargs):
        captured["env"] = kwargs.get("env")
        captured["timeout"] = kwargs.get("timeout")
        return _Proc()

    monkeypatch.setattr("kibrary_sidecar.kicad_install.subprocess.run", _fake_run)

    ki.register_custom_install(fake_cli)

    # env must be a dict (not None — that would mean "inherit", which is the
    # bug we're guarding against) and must NOT carry the PyInstaller marker.
    assert isinstance(captured["env"], dict)
    assert "LD_LIBRARY_PATH_ORIG" not in captured["env"]
    # Timeout is set so a hung binary doesn't lock the sidecar.
    assert captured["timeout"] is not None


def test_register_custom_install_dict_shape_matches_detect(tmp_path: Path, monkeypatch):
    """The custom install dict must carry the same keys as detect_installs()
    so the frontend list-renderer doesn't have to special-case it."""
    _isolate_custom_dirs(tmp_path, monkeypatch)
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.setattr("shutil.which", lambda _name: None)

    # Auto-detected reference dict
    regular_base = tmp_path / ".config" / "kicad"
    _make_kicad_config(regular_base, "9.0")
    detected = ki.detect_installs()
    assert detected, "fixture should produce one auto install"
    expected_keys = set(detected[0].keys())

    fake_cli = _fake_kicad_cli(tmp_path / "custom_bin_dir", "kicad-cli")
    _mock_subprocess_kicad_version(monkeypatch, "KiCad version 9.0.5")

    install = ki.register_custom_install(fake_cli)["install"]
    assert set(install.keys()) == expected_keys
