import json
from pathlib import Path
from unittest.mock import patch
from kibrary_sidecar.settings import read_settings, write_settings, settings_path

def test_settings_path_xdg(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert settings_path() == tmp_path / "kibrary" / "settings.json"

def test_read_returns_defaults_when_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    s = read_settings()
    assert s["theme"] == "dark"
    assert s["search_raph_io"]["enabled"] is False

def test_write_then_read_roundtrips(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    s = read_settings()
    s["theme"] = "light"
    write_settings(s)
    assert read_settings()["theme"] == "light"
