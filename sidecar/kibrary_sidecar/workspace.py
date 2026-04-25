import json
from pathlib import Path
from typing import Any

DEFAULT_SETTINGS: dict[str, Any] = {
    "version": 1,
    "kicad_target": None,
    "git": {
        "enabled": True,
        "auto_commit": True,
        "commit_template": "Add {lcsc} ({description}) to {library}",
    },
    "concurrency": 4,
}

def _settings_path(root: Path) -> Path:
    return root / ".kibrary" / "workspace.json"

def read_workspace_settings(root: str) -> dict:
    p = _settings_path(Path(root))
    if not p.is_file():
        return DEFAULT_SETTINGS
    return json.loads(p.read_text())

def open_workspace(root: str) -> dict:
    rp = Path(root)
    if not rp.is_dir():
        raise ValueError(f"Workspace path is not a directory: {root}")
    kdir = rp / ".kibrary"
    kdir.mkdir(exist_ok=True)
    (kdir / "staging").mkdir(exist_ok=True)
    (kdir / "cache").mkdir(exist_ok=True)
    sp = _settings_path(rp)
    first_run = not sp.is_file()
    if first_run:
        sp.write_text(json.dumps(DEFAULT_SETTINGS, indent=2))
    return {"root": str(rp), "settings": json.loads(sp.read_text()), "first_run": first_run}
