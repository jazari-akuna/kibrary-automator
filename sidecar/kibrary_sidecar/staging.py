import json
from pathlib import Path


def _path(staging_part: Path) -> Path:
    return staging_part / "meta.json"


def write_meta(staging_part: Path, meta: dict) -> None:
    staging_part.mkdir(parents=True, exist_ok=True)
    _path(staging_part).write_text(json.dumps(meta, indent=2))


def read_meta(staging_part: Path) -> dict | None:
    p = _path(staging_part)
    if not p.is_file():
        return None
    return json.loads(p.read_text())
