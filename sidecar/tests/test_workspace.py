import json
from pathlib import Path
from kibrary_sidecar.workspace import (
    open_workspace,
    read_workspace_settings,
    write_workspace_settings,
)
from kibrary_sidecar.handlers.workspace import workspace_set_settings


def test_write_workspace_settings_round_trips(tmp_path: Path):
    """write_workspace_settings persists to .kibrary/workspace.json and
    read_workspace_settings reads it back. Regression guard: the function was
    once called by the set_settings handler but never defined, so
    workspace.set_settings threw AttributeError (broke the First-Run Wizard).
    """
    ws = tmp_path / "repo"
    ws.mkdir()
    open_workspace(str(ws))
    new = {
        "version": 1,
        "kicad_target": "/opt/kicad",
        "git": {"enabled": False, "auto_commit": False, "commit_template": "x"},
        "concurrency": 8,
    }
    write_workspace_settings(str(ws), new)
    assert read_workspace_settings(str(ws)) == new


def test_set_settings_handler_persists(tmp_path: Path):
    """The RPC handler (the exact path that threw AttributeError) works."""
    ws = tmp_path / "repo"
    ws.mkdir()
    open_workspace(str(ws))
    resp = workspace_set_settings(
        {"root": str(ws), "settings": {**read_workspace_settings(str(ws)), "concurrency": 12}}
    )
    assert resp == {"ok": True}
    assert read_workspace_settings(str(ws))["concurrency"] == 12


def test_write_workspace_settings_merges_partial(tmp_path: Path):
    """A partial payload never drops unrelated keys (top-level merge)."""
    ws = tmp_path / "repo"
    ws.mkdir()
    open_workspace(str(ws))
    write_workspace_settings(str(ws), {"kicad_target": "/x"})
    got = read_workspace_settings(str(ws))
    assert got["kicad_target"] == "/x"
    assert got["concurrency"] == 4  # untouched default preserved


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

def test_open_workspace_first_run_true_when_new(tmp_path: Path):
    ws = tmp_path / "brand_new"
    ws.mkdir()
    info = open_workspace(str(ws))
    assert info["first_run"] is True

def test_open_workspace_first_run_false_when_existing(tmp_path: Path):
    ws = tmp_path / "existing"
    ws.mkdir()
    open_workspace(str(ws))  # creates workspace.json
    info = open_workspace(str(ws))  # second call — not first run
    assert info["first_run"] is False


# ---------------------------------------------------------------------------
# .kibrary/.gitignore — silences staging-churn dirty warnings
# ---------------------------------------------------------------------------

def test_open_workspace_writes_kibrary_gitignore(tmp_path: Path):
    """A fresh workspace gets `.kibrary/.gitignore` excluding scratch dirs.

    Without this, every in-flight download or render cache shows up as
    untracked in the user's git repo, which trips the auto_commit
    "working tree dirty" check. The gitignore makes scratch invisible to
    git so auto-commit can run cleanly while parts are still staging.
    """
    ws = tmp_path / "withgi"
    ws.mkdir()
    open_workspace(str(ws))
    gi = ws / ".kibrary" / ".gitignore"
    assert gi.is_file()
    text = gi.read_text()
    assert "staging/" in text
    assert "cache/" in text


def test_open_workspace_does_not_overwrite_user_gitignore(tmp_path: Path):
    """User customisations to `.kibrary/.gitignore` survive re-opens.

    Some users may want to ignore additional scratch dirs (e.g. private
    notes). The function is idempotent: it writes the default only when
    the file is absent, never on top of existing content.
    """
    ws = tmp_path / "custom"
    ws.mkdir()
    open_workspace(str(ws))  # creates default
    gi = ws / ".kibrary" / ".gitignore"
    custom = "staging/\ncache/\nnotes.md\n"
    gi.write_text(custom)
    open_workspace(str(ws))  # re-open
    assert gi.read_text() == custom


def test_open_workspace_self_heals_old_workspace(tmp_path: Path):
    """A workspace opened pre-fix (no .gitignore yet) gets one written
    on the next open. Critical for users with existing libraries whose
    `.kibrary/` dir was created before this fix landed."""
    ws = tmp_path / "legacy"
    ws.mkdir()
    (ws / ".kibrary").mkdir()
    (ws / ".kibrary" / "staging").mkdir()
    # Simulate a legacy workspace.json so first_run = False.
    (ws / ".kibrary" / "workspace.json").write_text('{"version": 1}')
    assert not (ws / ".kibrary" / ".gitignore").exists()
    open_workspace(str(ws))
    assert (ws / ".kibrary" / ".gitignore").is_file()
