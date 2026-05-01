"""KiCad installation detection, cross-OS.

Public API
----------
detect_installs()         -> list[dict]   fresh scan every call (auto-detected only)
cached_installs()         -> list[dict]   read from ~/.config/kibrary/kicad-installs.json,
                                           refresh if stale (>24 h) or absent;
                                           custom-registered installs are always merged in
refresh_cache()           -> list[dict]   force rescan and persist
register_custom_install() -> dict         register a user-picked kicad-cli binary as
                                           a "custom" install; persists across cache refreshes

Each install dict has the keys:
  id, type, version, config_dir, sym_table, fp_table,
  kicad_bin, kicad_cli_bin, eeschema_bin, pcbnew_bin
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

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
    kicad_bin: Any,
    eeschema_bin: Any,
    pcbnew_bin: Any,
    kicad_cli_bin: Any = None,
    install_id: str | None = None,
) -> dict[str, Any]:
    sym_table = str(config_dir / "sym-lib-table")
    fp_table = str(config_dir / "fp-lib-table")
    return {
        "id": install_id or f"{install_type.lower()}-{version}",
        "type": install_type,
        "version": version,
        "config_dir": str(config_dir),
        "sym_table": sym_table,
        "fp_table": fp_table,
        "kicad_bin": kicad_bin,
        "kicad_cli_bin": kicad_cli_bin,
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
                # Emit each bin as a *list* (argv-style) so callers can
                # spawn them directly via subprocess.Popen without having
                # to shell-split a string. Matches the contract in
                # ``editor.open_editor`` which checks ``isinstance(bin, list)``.
                kicad_bin=[
                    "flatpak", "run", "--command=kicad", "org.kicad.KiCad"
                ],
                kicad_cli_bin=[
                    "flatpak", "run", "--command=kicad-cli", "org.kicad.KiCad"
                ],
                eeschema_bin=[
                    "flatpak", "run", "--command=eeschema", "org.kicad.KiCad"
                ],
                pcbnew_bin=[
                    "flatpak", "run", "--command=pcbnew", "org.kicad.KiCad"
                ],
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
                kicad_cli_bin=shutil.which("kicad-cli"),
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
                kicad_cli_bin=_mac_bin("kicad-cli"),
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
                kicad_cli_bin=_win_bin("kicad-cli"),
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
    """Force a fresh detection scan and write the result to the cache file.

    Custom installs registered via :func:`register_custom_install` live in a
    separate file and are merged on top — they survive cache refreshes so the
    user only registers them once.
    """
    installs = detect_installs()
    _write_cache(installs)
    return _merge_with_customs(installs)


def cached_installs() -> list[dict]:
    """Return cached installs, refreshing if the cache is stale (>24 h) or absent.

    Always merges in user-registered custom installs.
    """
    cached = _read_cache()
    if cached is None:
        return refresh_cache()
    return _merge_with_customs(cached)


# ---------------------------------------------------------------------------
# Custom installs (user-registered via file picker)
# ---------------------------------------------------------------------------

_KICAD_VERSION_RE_FALLBACK = "9.0"


def _custom_installs_path() -> Path:
    """Path to the JSON file holding user-registered custom installs.

    Lives next to the auto-detect cache but is independent of it: the cache
    expires every 24 h, the custom list does not.
    """
    return _cache_path().parent / "kicad-custom-installs.json"


def _read_custom_installs() -> list[dict]:
    p = _custom_installs_path()
    if not p.is_file():
        return []
    try:
        payload = json.loads(p.read_text())
        installs = payload.get("installs") if isinstance(payload, dict) else payload
        return list(installs) if installs else []
    except Exception as exc:  # noqa: BLE001 — corrupt file ≈ no customs
        log.warning("custom installs file unreadable, ignoring: %s", exc)
        return []


def _write_custom_installs(installs: list[dict]) -> None:
    """Atomic write: temp file + rename, so a crash mid-write can't corrupt."""
    p = _custom_installs_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    payload = {"written_at": time.time(), "installs": installs}
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(p)


def _merge_with_customs(detected: list[dict]) -> list[dict]:
    """Append custom installs to the auto-detected list, deduplicating by id."""
    customs = _read_custom_installs()
    if not customs:
        return list(detected)
    detected_ids = {i.get("id") for i in detected}
    merged = list(detected)
    for c in customs:
        if c.get("id") in detected_ids:
            continue
        merged.append(c)
    return merged


def _parse_kicad_version(output: str) -> str | None:
    """Extract a 'X.Y' (and optionally '.Z') version from kicad-cli --version output.

    kicad-cli prints things like:
        KiCad version 9.0.5
        kicad-cli (KiCad 9.0.0)
        9.0.0+unknown~something
    We just need the leading X.Y for the dict's `version` field (matches the
    auto-detect format) plus require the word "KiCad" appears somewhere so we
    don't accept unrelated tools.
    """
    import re

    if "kicad" not in output.lower():
        return None
    m = re.search(r"\b(\d+)\.(\d+)(?:\.\d+)?\b", output)
    if not m:
        return None
    return f"{m.group(1)}.{m.group(2)}"


def _system_env_for_probe() -> dict[str, str]:
    """Reuse svg_render._system_env() to scrub PyInstaller's LD_LIBRARY_PATH.

    Imported lazily to avoid a hard dependency at module-import time
    (svg_render pulls in subprocess/tempfile we don't need for detection).
    """
    from kibrary_sidecar.svg_render import _system_env
    return _system_env()


def register_custom_install(path: str | Path) -> dict[str, Any]:
    """Register a user-picked KiCad binary as a "custom" install.

    Parameters
    ----------
    path
        Absolute path to a binary the user picked via a file dialog. Typically
        ``kicad-cli`` but ``kicad`` (the launcher) is also accepted.

    Returns
    -------
    {"install": <new install dict>, "all_installs": <list of all installs after registration>}

    Raises
    ------
    FileNotFoundError
        Path does not exist.
    PermissionError
        Path exists but is not executable.
    ValueError
        The binary did not look like a KiCad executable (probe via ``--version``
        produced output that didn't include "KiCad" + a version number).
    """
    # 1. Resolve to absolute, follow symlinks
    raw = Path(path).expanduser()
    try:
        resolved = raw.resolve(strict=True)
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"No such file: {raw}") from exc

    # 2. Validate exists + executable
    if not resolved.is_file():
        raise FileNotFoundError(f"Not a regular file: {resolved}")
    if not os.access(str(resolved), os.X_OK):
        raise PermissionError(f"Not executable: {resolved}")

    # 3. Probe — kicad-cli (or kicad) --version, scrub PyInstaller env
    try:
        proc = subprocess.run(
            [str(resolved), "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            env=_system_env_for_probe(),
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError(
            f"Timed out probing {resolved} with --version (5s)"
        ) from exc
    except OSError as exc:
        raise ValueError(f"Could not exec {resolved}: {exc}") from exc

    output = (proc.stdout or "") + (proc.stderr or "")
    version = _parse_kicad_version(output)
    if version is None:
        snippet = output.strip().splitlines()[0:3]
        raise ValueError(
            f"{resolved} does not appear to be a KiCad binary. "
            f"`{resolved.name} --version` output: "
            + (" | ".join(snippet) if snippet else "<empty>")
        )

    # 4. Companion paths — look in the same directory for the editor binaries.
    bin_dir = resolved.parent
    name_lower = resolved.name.lower()

    def _find_companion(*names: str) -> str | None:
        # Try each candidate in the picked binary's directory; if none exists,
        # fall back to the system PATH (so a user who picked kicad-cli from a
        # symlink farm still gets the editor binary if it's globally installed).
        for n in names:
            candidate = bin_dir / n
            if candidate.is_file() and os.access(str(candidate), os.X_OK):
                return str(candidate)
        for n in names:
            on_path = shutil.which(n)
            if on_path:
                return on_path
        return None

    if name_lower in ("kicad-cli", "kicad-cli.exe"):
        kicad_cli_bin: str | None = str(resolved)
        kicad_bin = _find_companion("kicad", "kicad.exe")
    elif name_lower in ("kicad", "kicad.exe"):
        kicad_bin = str(resolved)
        kicad_cli_bin = _find_companion("kicad-cli", "kicad-cli.exe")
    else:
        # Unknown name — treat it as kicad-cli (it answered to --version like
        # one) and best-effort look up `kicad` next to it.
        kicad_cli_bin = str(resolved)
        kicad_bin = _find_companion("kicad", "kicad.exe")

    eeschema_bin = _find_companion("eeschema", "eeschema.exe")
    pcbnew_bin = _find_companion("pcbnew", "pcbnew.exe")

    # 5. Build the install dict — match detect_installs() shape exactly.
    # Custom installs don't carry their own KiCad config_dir; reuse the
    # auto-detected one for the same major.minor if we have it, otherwise
    # synthesise a path under the standard XDG location so the sym/fp tables
    # at least point somewhere that exists for this user's KiCad.
    config_dir = _config_dir_for_version(version)

    # Stable id: `custom-<version>` if unique, else `custom-<sha1[:10]>` of
    # the resolved path so two custom installs of the same version don't
    # collide.
    primary_id = f"custom-{version}"
    existing_customs = _read_custom_installs()
    existing_ids = {c.get("id") for c in existing_customs}
    same_path_existing = next(
        (c for c in existing_customs if c.get("kicad_cli_bin") == str(resolved)),
        None,
    )
    if same_path_existing is not None:
        install_id = same_path_existing["id"]  # replace in place
    elif primary_id in existing_ids:
        digest = hashlib.sha1(str(resolved).encode("utf-8")).hexdigest()[:10]
        install_id = f"custom-{digest}"
    else:
        install_id = primary_id

    install = _make_install(
        install_type="custom",
        version=version,
        config_dir=config_dir,
        kicad_bin=kicad_bin,
        kicad_cli_bin=kicad_cli_bin,
        eeschema_bin=eeschema_bin,
        pcbnew_bin=pcbnew_bin,
        install_id=install_id,
    )

    # 6. Persist — replace any entry with the same id OR same kicad_cli_bin.
    new_customs = [
        c for c in existing_customs
        if c.get("id") != install_id and c.get("kicad_cli_bin") != str(resolved)
    ]
    new_customs.append(install)
    _write_custom_installs(new_customs)

    # 7. Return new install + the merged full list (auto + custom).
    detected = _read_cache()
    if detected is None:
        detected = detect_installs()
    all_installs = _merge_with_customs(detected)
    return {"install": install, "all_installs": all_installs}


def _config_dir_for_version(version: str) -> Path:
    """Best-effort KiCad config dir for a given X.Y version.

    Matches what auto-detect would have used on this OS. The directory may
    not exist (custom KiCad builds sometimes use a non-standard config root)
    — we don't validate; the dict's sym_table/fp_table fields are advisory.
    """
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Preferences" / "kicad" / version
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", str(Path.home()))
        return Path(appdata) / "kicad" / version
    # Linux (and unknown): prefer Flatpak path if a Flatpak config dir exists,
    # otherwise the regular ~/.config/kicad path.
    flatpak_dir = (
        Path.home() / ".var" / "app" / "org.kicad.KiCad" / "config" / "kicad" / version
    )
    if flatpak_dir.is_dir():
        return flatpak_dir
    return Path.home() / ".config" / "kicad" / version
