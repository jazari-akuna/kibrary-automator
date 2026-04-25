import json
from pathlib import Path
from kibrary_sidecar.staging import write_meta, read_meta


def test_roundtrip(tmp_path: Path):
    d = tmp_path / "C1525"; d.mkdir()
    meta = {"lcsc": "C1525", "status": "ready", "edits": {"description": "10kΩ"}}
    write_meta(d, meta)
    assert read_meta(d) == meta


def test_read_meta_missing_returns_none(tmp_path: Path):
    assert read_meta(tmp_path / "ghost") is None
