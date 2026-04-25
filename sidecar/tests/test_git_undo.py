"""Tests for git_undo.undo_last_commit."""
from pathlib import Path

import git
import pytest

from kibrary_sidecar.git_undo import undo_last_commit


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_repo(path: Path) -> git.Repo:
    """Initialise a bare-bones git repo in *path* with a working identity."""
    repo = git.Repo.init(path)
    cw = repo.config_writer()
    cw.set_value("user", "name", "Test User")
    cw.set_value("user", "email", "test@test.com")
    cw.release()
    return repo


def _make_commit(repo: git.Repo, path: Path, filename: str, content: str, message: str) -> str:
    """Write a file, stage it, commit, and return the full SHA."""
    (path / filename).write_text(content)
    repo.index.add([filename])
    commit = repo.index.commit(message)
    return commit.hexsha


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_undo_last_resets_when_sha_matches(tmp_path: Path):
    """undo_last_commit resets HEAD to the first commit when SHA matches."""
    repo = _make_repo(tmp_path)

    sha1 = _make_commit(repo, tmp_path, "a.txt", "first", "first commit")
    sha2 = _make_commit(repo, tmp_path, "b.txt", "second", "second commit")

    assert repo.head.commit.hexsha == sha2

    result = undo_last_commit(tmp_path, sha2)

    assert result == {"ok": True}, f"Expected ok=True, got {result}"
    assert repo.head.commit.hexsha == sha1, "HEAD should have moved to the first commit"
    # The file from the second commit should no longer exist in the working tree.
    assert not (tmp_path / "b.txt").exists()


def test_undo_last_refuses_when_sha_mismatches(tmp_path: Path):
    """undo_last_commit refuses when the expected SHA is not HEAD."""
    repo = _make_repo(tmp_path)

    sha1 = _make_commit(repo, tmp_path, "a.txt", "first", "first commit")
    sha2 = _make_commit(repo, tmp_path, "b.txt", "second", "second commit")
    _sha3 = _make_commit(repo, tmp_path, "c.txt", "third", "third commit")

    # sha2 is now HEAD~1, not HEAD — the call should be refused.
    result = undo_last_commit(tmp_path, sha2)

    assert result["ok"] is False, f"Expected ok=False, got {result}"
    assert "reason" in result
    # HEAD must not have moved.
    assert repo.head.commit.hexsha == _sha3


def test_undo_last_refuses_when_dirty_tree(tmp_path: Path):
    """undo_last_commit refuses when the working tree is dirty."""
    repo = _make_repo(tmp_path)

    sha1 = _make_commit(repo, tmp_path, "a.txt", "first", "first commit")
    sha2 = _make_commit(repo, tmp_path, "b.txt", "second", "second commit")

    # Make the working tree dirty (untracked file).
    (tmp_path / "dirty.txt").write_text("uncommitted changes")

    result = undo_last_commit(tmp_path, sha2)

    assert result["ok"] is False, f"Expected ok=False, got {result}"
    assert "reason" in result
    assert "dirty" in result["reason"].lower()
    # HEAD must not have moved.
    assert repo.head.commit.hexsha == sha2
