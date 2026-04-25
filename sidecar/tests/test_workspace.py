import json
from pathlib import Path
from kibrary_sidecar.workspace import open_workspace, read_workspace_settings

def test_open_workspace_creates_kibrary_dir(tmp_path: Path):
    ws = tmp_path / "myrepo"
    ws.mkdir()
    info = open_workspace(str(ws))
    assert (ws / ".kibrary").is_dir()
    assert (ws / ".kibrary" / "workspace.json").is_file()
    assert info["root"] == str(ws)
    assert info["settings"]["git"]["enabled"] is True

def test_open_workspace_idempotent(tmp_path: Path):
    ws = tmp_path / "repo2"
    ws.mkdir()
    open_workspace(str(ws))
    custom = json.loads((ws / ".kibrary" / "workspace.json").read_text())
    custom["concurrency"] = 8
    (ws / ".kibrary" / "workspace.json").write_text(json.dumps(custom))
    info = open_workspace(str(ws))
    assert info["settings"]["concurrency"] == 8
