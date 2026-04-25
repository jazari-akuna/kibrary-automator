"""KiCad installation detection, cross-OS.

Public API
----------
detect_installs()  -> list[dict]   fresh scan every call
cached_installs()  -> list[dict]   read from ~/.config/kibrary/kicad-installs.json,
                                    refresh if stale (>24 h) or absent
refresh_cache()    -> list[dict]   force rescan and persist

Each install dict has the keys:
  id, type, version, config_dir, sym_table, fp_table,
  kicad_bin, eeschema_bin, pcbnew_bin
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

_CACHE_MAX_AGE_S = 24 * 3600  # 24 hours


def _cache_path() -> Path:
    """Path to the JSON cache file (platform-aware, mirrors settings.py logic)."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", str(Path.home())))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    return base / "kibrary" / "kicad-installs.json"


def _write_cache(installs: list[dict]) -> None:
    p = _cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {"written_at": time.time(), "installs": installs}
    p.write_text(json.dumps(payload, indent=2))


def _read_cache() -> list[dict] | None:
    """Return cached list if present and fresh, else None."""
    p = _cache_path()
    if not p.is_file():
        return None
    try:
        payload = json.loads(p.read_text())
        age = time.time() - float(payload.get("written_at", 0))
        if age > _CACHE_MAX_AGE_S:
            return None
        return payload["installs"]
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Per-OS detection helpers
# ---------------------------------------------------------------------------

def _version_dirs(parent: Path) -> list[str]:
    """List sub-directory names that look like KiCad version numbers."""
    if not parent.is_dir():
        return []
    return sorted(
        [d.name for d in parent.iterdir() if d.is_dir()],
        reverse=True,
    )


def _make_install(
    *,
    install_type: str,
    version: str,
    config_dir: Path,
    kicad_bin: str | None,
    eeschema_bin: str | None,
    pcbnew_bin: str | None,
) -> dict[str, Any]:
    sym_table = str(config_dir / "sym-lib-table")
    fp_table = str(config_dir / "fp-lib-table")
    return {
        "id": f"{install_type.lower()}-{version}",
        "type": install_type,
        "version": version,
        "config_dir": str(config_dir),
        "sym_table": sym_table,
        "fp_table": fp_table,
        "kicad_bin": kicad_bin,
        "eeschema_bin": eeschema_bin,
        "pcbnew_bin": pcbnew_bin,
    }


def _detect_linux_flatpak() -> list[dict]:
    """Detect Flatpak KiCad installs on Linux."""
    results: list[dict] = []
    base = Path.home() / ".var" / "app" / "org.kicad.KiCad" / "config" / "kicad"
    for version in _version_dirs(base):
        config_dir = base / version
        sym = config_dir / "sym-lib-table"
        fp = config_dir / "fp-lib-table"
        if not (sym.is_file() and fp.is_file()):
            continue
        results.append(
            _make_install(
                install_type="flatpak",
                version=version,
                config_dir=config_dir,
                kicad_bin=(
                    "flatpak run --command=kicad org.kicad.KiCad"
                ),
                eeschema_bin=(
                    "flatpak run --command=eeschema org.kicad.KiCad"
                ),
                pcbnew_bin=(
                    "flatpak run --command=pcbnew org.kicad.KiCad"
                ),
            )
        )
    return results


def _detect_linux_regular() -> list[dict]:
    """Detect regular (distro / upstream) KiCad installs on Linux."""
    results: list[dict] = []
    base = Path.home() / ".config" / "kicad"
    for version in _version_dirs(base):
        config_dir = base / version
        sym = config_dir / "sym-lib-table"
        fp = config_dir / "fp-lib-table"
        if not (sym.is_file() and fp.is_file()):
            continue
        results.append(
            _make_install(
                install_type="linux",
                version=version,
                config_dir=config_dir,
                kicad_bin=shutil.which("kicad"),
                eeschema_bin=shutil.which("eeschema"),
                pcbnew_bin=shutil.which("pcbnew"),
            )
        )
    return results


def _detect_macos() -> list[dict]:
    """Detect KiCad installs on macOS."""
    results: list[dict] = []
    base = Path.home() / "Library" / "Preferences" / "kicad"
    app_macos = Path("/Applications/KiCad/KiCad.app/Contents/MacOS")
    for version in _version_dirs(base):
        config_dir = base / version
        sym = config_dir / "sym-lib-table"
        fp = config_dir / "fp-lib-table"
        if not (sym.is_file() and fp.is_file()):
            continue

        def _mac_bin(name: str) -> str | None:
            p = app_macos / name
            return str(p) if p.is_file() else shutil.which(name)

        results.append(
            _make_install(
                install_type="macos",
                version=version,
                config_dir=config_dir,
                kicad_bin=_mac_bin("kicad"),
                eeschema_bin=_mac_bin("eeschema"),
                pcbnew_bin=_mac_bin("pcbnew"),
            )
        )
    return results


def _detect_windows() -> list[dict]:
    """Detect KiCad installs on Windows."""
    results: list[dict] = []
    appdata = os.environ.get("APPDATA", str(Path.home()))
    base = Path(appdata) / "kicad"
    for version in _version_dirs(base):
        config_dir = base / version
        sym = config_dir / "sym-lib-table"
        fp = config_dir / "fp-lib-table"
        if not (sym.is_file() and fp.is_file()):
            continue

        prog_files = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
        bin_dir = prog_files / "KiCad" / version / "bin"

        def _win_bin(name: str) -> str | None:
            p = bin_dir / f"{name}.exe"
            return str(p) if p.is_file() else shutil.which(name)

        results.append(
            _make_install(
                install_type="windows",
                version=version,
                config_dir=config_dir,
                kicad_bin=_win_bin("kicad"),
                eeschema_bin=_win_bin("eeschema"),
                pcbnew_bin=_win_bin("pcbnew"),
            )
        )
    return results


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def detect_installs() -> list[dict]:
    """Return a list of detected KiCad installs across all supported OS layouts.

    Each dict contains:
        id, type, version, config_dir, sym_table, fp_table,
        kicad_bin, eeschema_bin, pcbnew_bin
    """
    results: list[dict] = []

    if sys.platform.startswith("linux"):
        results.extend(_detect_linux_flatpak())
        results.extend(_detect_linux_regular())
    elif sys.platform == "darwin":
        results.extend(_detect_macos())
    elif sys.platform == "win32":
        results.extend(_detect_windows())
    else:
        # Unknown platform: try everything best-effort
        results.extend(_detect_linux_flatpak())
        results.extend(_detect_linux_regular())
        results.extend(_detect_macos())
        results.extend(_detect_windows())

    return results


def refresh_cache() -> list[dict]:
    """Force a fresh detection scan and write the result to the cache file."""
    installs = detect_installs()
    _write_cache(installs)
    return installs


def cached_installs() -> list[dict]:
    """Return cached installs, refreshing if the cache is stale (>24 h) or absent."""
    cached = _read_cache()
    if cached is not None:
        return cached
    return refresh_cache()
