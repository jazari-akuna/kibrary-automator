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
