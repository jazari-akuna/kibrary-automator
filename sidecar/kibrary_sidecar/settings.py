import json
import os
import sys
from pathlib import Path

DEFAULTS = {
    "theme": "dark",
    "search_raph_io": {"enabled": False, "base_url": "https://search.raph.io", "api_key": ""},
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

def read_settings() -> dict:
    p = settings_path()
    if not p.is_file():
        return dict(DEFAULTS)
    raw = json.loads(p.read_text())
    out = dict(DEFAULTS)
    out.update(raw)
    return out

def write_settings(s: dict) -> None:
    p = settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(s, indent=2))
