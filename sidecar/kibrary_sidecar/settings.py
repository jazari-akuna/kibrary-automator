import json
import os
import sys
from pathlib import Path

DEFAULTS = {
    "theme": "dark",
    "search_raph_io": {"enabled": False, "base_url": "https://search.raph.io"},
    "concurrency": 4,
    "kicad_install": None,
}

def _config_root() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home())))
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))

def settings_path() -> Path:
    return _config_root() / "kibrary" / "settings.json"

def _migrate_api_key(raw: dict) -> dict:
    """If settings.json still contains search_raph_io.api_key, migrate it
    to the OS keychain and strip it from the returned dict (also rewrites
    the JSON file so subsequent reads skip this branch).
    """
    search = raw.get("search_raph_io", {})
    api_key = search.get("api_key", "")
    if not api_key:
        return raw

    # Import here to avoid circular dependency at module load time.
    from kibrary_sidecar import secrets  # noqa: PLC0415
    secrets.set_secret("search_raph_io_api_key", api_key)

    # Strip the key from the in-memory dict.
    new_search = {k: v for k, v in search.items() if k != "api_key"}
    migrated = {**raw, "search_raph_io": new_search}

    # Persist the cleaned-up settings so we don't re-migrate on next read.
    write_settings(migrated)

    return migrated

def read_settings() -> dict:
    p = settings_path()
    if not p.is_file():
        return dict(DEFAULTS)
    raw = json.loads(p.read_text())
    # One-time migration: move api_key from disk to OS keychain.
    raw = _migrate_api_key(raw)
    out = dict(DEFAULTS)
    out.update(raw)
    return out

def write_settings(s: dict) -> None:
    # Ensure api_key is never written back to disk.
    s = dict(s)
    if "search_raph_io" in s:
        s["search_raph_io"] = {
            k: v for k, v in s["search_raph_io"].items() if k != "api_key"
        }
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(s, indent=2))


# ---------------------------------------------------------------------------
# Active KiCad install (alpha.18)
# ---------------------------------------------------------------------------
#
# `kicad_install` settings key holds the *id* of the install the rest of the
# app should use (the install dict itself comes from kicad_install.cached_installs()).
# Helpers below abstract that lookup so callers don't have to do the
# settings-read + cache-walk dance every time.

def get_active_install() -> dict | None:
    """Return the active KiCad install dict, or None if none is set or the
    persisted id no longer matches any detected install (e.g. KiCad was
    uninstalled between sessions)."""
    # Local import to avoid a circular dependency at module load time
    # (kicad_install imports nothing from settings, but a cycle could
    # appear if either module grows).
    from kibrary_sidecar import kicad_install  # noqa: PLC0415

    install_id = read_settings().get("kicad_install")
    if not install_id:
        return None
    for ins in kicad_install.cached_installs():
        if ins.get("id") == install_id:
            return ins
    return None


def set_active_install(install_id: str | None) -> None:
    """Persist the active install id (or clear it when ``install_id`` is None)."""
    s = read_settings()
    s["kicad_install"] = install_id
    write_settings(s)
