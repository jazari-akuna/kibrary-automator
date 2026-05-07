"""Tests for git_ops module — written BEFORE implementation (TDD)."""
from pathlib import Path

import git
import pytest

from kibrary_sidecar.git_ops import (
    auto_commit,
    init_repo,
    is_clean_repo,
    is_safe_to_commit,
)


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


def _initial_commit(repo: git.Repo, path: Path) -> None:
    """Create a first commit so the repo has a valid HEAD."""
    seed = path / ".gitkeep"
    seed.write_text("")
    repo.index.add([".gitkeep"])
    repo.index.commit("initial")


# ---------------------------------------------------------------------------
# init_repo
# ---------------------------------------------------------------------------


def test_init_repo_creates_git_dir(tmp_path: Path):
    target = tmp_path / "newrepo"
    target.mkdir()
    init_repo(target)
    assert (target / ".git").is_dir()


def test_init_repo_idempotent(tmp_path: Path):
    """Calling init_repo on an already-initialised repo should not raise."""
    _make_repo(tmp_path)
    init_repo(tmp_path)  # should not raise
    assert (tmp_path / ".git").is_dir()


# ---------------------------------------------------------------------------
# is_safe_to_commit
# ---------------------------------------------------------------------------


def test_is_safe_returns_false_for_non_repo(tmp_path: Path):
    plain_dir = tmp_path / "notrepo"
    plain_dir.mkdir()
    safe, reason = is_safe_to_commit(plain_dir)
    assert safe is False
    assert reason is not None
    assert "not a git repository" in reason.lower()


def test_is_safe_returns_true_for_fresh_repo(tmp_path: Path):
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    safe, reason = is_safe_to_commit(tmp_path)
    assert safe is True
    assert reason is None


def test_is_safe_returns_false_for_detached_head(tmp_path: Path):
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    # Make a second commit so we can detach from the first
    (tmp_path / "extra.txt").write_text("x")
    repo.index.add(["extra.txt"])
    repo.index.commit("second")
    # Detach HEAD at the first commit (parent of HEAD)
    first_sha = list(repo.iter_commits())[-1].hexsha
    repo.git.checkout(first_sha)  # detaches HEAD
    safe, reason = is_safe_to_commit(tmp_path)
    assert safe is False
    assert "detached" in reason.lower()


def test_is_safe_returns_false_for_mid_merge(tmp_path: Path):
    """Simulate a merge conflict state by writing MERGE_HEAD."""
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    # Write MERGE_HEAD to mimic a mid-merge state
    merge_head_file = tmp_path / ".git" / "MERGE_HEAD"
    merge_head_file.write_text(repo.head.commit.hexsha + "\n")
    safe, reason = is_safe_to_commit(tmp_path)
    assert safe is False
    assert "merge" in reason.lower()


def test_is_safe_returns_false_for_mid_rebase(tmp_path: Path):
    """Simulate a rebase in progress by creating the rebase-merge directory."""
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    rebase_dir = tmp_path / ".git" / "rebase-merge"
    rebase_dir.mkdir()
    safe, reason = is_safe_to_commit(tmp_path)
    assert safe is False
    assert "rebase" in reason.lower()


def test_is_safe_returns_false_for_mid_bisect(tmp_path: Path):
    """Simulate a bisect in progress by creating BISECT_HEAD."""
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    bisect_file = tmp_path / ".git" / "BISECT_HEAD"
    bisect_file.write_text(repo.head.commit.hexsha + "\n")
    safe, reason = is_safe_to_commit(tmp_path)
    assert safe is False
    assert "bisect" in reason.lower()


# ---------------------------------------------------------------------------
# is_clean_repo
# ---------------------------------------------------------------------------


def test_is_clean_repo_true_for_committed(tmp_path: Path):
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    assert is_clean_repo(tmp_path) is True


def test_is_clean_repo_false_for_untracked(tmp_path: Path):
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    (tmp_path / "dirty.txt").write_text("dirty")
    assert is_clean_repo(tmp_path) is False


# ---------------------------------------------------------------------------
# auto_commit
# ---------------------------------------------------------------------------


def test_auto_commit_skips_when_disabled(tmp_path: Path):
    _make_repo(tmp_path)
    result = auto_commit(tmp_path, "msg", ["f.txt"], enabled=False)
    assert result is None


def test_auto_commit_creates_commit_when_safe(tmp_path: Path):
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    target = tmp_path / "f.txt"
    target.write_text("hello")
    sha = auto_commit(tmp_path, "test commit", ["f.txt"])
    assert sha is not None
    assert len(sha) == 40  # full hex SHA
    log = list(repo.iter_commits())
    assert log[0].message.startswith("test commit")


def test_auto_commit_refuses_dirty_tree_outside_paths(tmp_path: Path):
    """Unrelated dirty file should block the auto-commit."""
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    # File we intend to commit
    (tmp_path / "good.txt").write_text("good")
    # Unrelated dirty file (staged but not in our paths list)
    (tmp_path / "dirty.txt").write_text("dirty")
    repo.index.add(["dirty.txt"])  # stage it but don't include in paths
    result = auto_commit(tmp_path, "should not commit", ["good.txt"])
    assert result is None


def test_auto_commit_returns_none_when_unsafe(tmp_path: Path):
    """auto_commit returns None when in a mid-merge state."""
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    # Inject mid-merge state
    (tmp_path / ".git" / "MERGE_HEAD").write_text(
        repo.head.commit.hexsha + "\n"
    )
    (tmp_path / "f.txt").write_text("data")
    result = auto_commit(tmp_path, "should not commit", ["f.txt"])
    assert result is None


# ---------------------------------------------------------------------------
# auto_commit: noisy "working tree dirty" warning classification
#
# Pre-fix the warning fired any time the workspace had ANY dirty file outside
# the auto-commit's target paths — including in-flight downloads under
# `.kibrary/staging/`. That's normal background activity (parts still being
# downloaded) but the warning made users think something was broken.
#
# Post-fix the commit is still skipped (defensive: never sweep unrelated
# state into the automated commit) but the LOG LEVEL now distinguishes
# "expected scratch churn" from "potentially worrying user WIP".
# ---------------------------------------------------------------------------


def test_auto_commit_dirt_in_kibrary_only_logs_at_debug(tmp_path: Path, caplog):
    """When the only dirt outside target paths is under `.kibrary/`, the
    skip is logged at DEBUG, not WARNING — the user shouldn't see a scary
    warning every time another part is mid-download."""
    import logging
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    # File we intend to commit
    (tmp_path / "Resistors_KSL").mkdir()
    (tmp_path / "Resistors_KSL" / "Resistors_KSL.kicad_sym").write_text("(kicad_symbol_lib)")
    # Concurrent staging activity for a different part
    staging = tmp_path / ".kibrary" / "staging" / "C25804"
    staging.mkdir(parents=True)
    (staging / "C25804.kicad_sym").write_text("(in flight)")

    caplog.set_level(logging.DEBUG, logger="kibrary_sidecar.git_ops")
    result = auto_commit(
        tmp_path, "Add Resistors_KSL", ["Resistors_KSL/Resistors_KSL.kicad_sym"]
    )
    # Still skipped (defensive)
    assert result is None
    # But NOT a warning — DEBUG only
    warnings = [
        r for r in caplog.records
        if r.levelno >= logging.WARNING and r.name.startswith("kibrary_sidecar")
    ]
    assert warnings == [], (
        f"expected no warnings for kibrary-internal dirt, got: "
        f"{[r.getMessage() for r in warnings]}"
    )


def test_auto_commit_dirt_outside_kibrary_still_warns(tmp_path: Path, caplog):
    """Dirt in tracked source files outside `.kibrary/` still produces a
    WARNING — that's potentially user WIP that the commit would risk
    sweeping up. Behavioural-equivalent to the pre-fix UX for that case."""
    import logging
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    # File we intend to commit
    (tmp_path / "good.txt").write_text("good")
    # Unrelated user-WIP file in repo root (not under .kibrary/)
    (tmp_path / "user_wip.kicad_sch").write_text("user WIP — don't commit")

    caplog.set_level(logging.DEBUG, logger="kibrary_sidecar.git_ops")
    result = auto_commit(tmp_path, "should not commit", ["good.txt"])
    assert result is None
    # WARNING-level record SHOULD exist this time.
    warning_msgs = [
        r.getMessage() for r in caplog.records
        if r.levelno >= logging.WARNING and "auto_commit" in r.getMessage()
    ]
    assert any("dirty outside target paths" in m for m in warning_msgs), warning_msgs


def test_auto_commit_mixed_dirt_warns_only_on_external(tmp_path: Path, caplog):
    """When dirt spans both `.kibrary/` AND a user file, the WARNING
    mentions only the user file (the kibrary churn doesn't deserve
    pollution of the warning text)."""
    import logging
    repo = _make_repo(tmp_path)
    _initial_commit(repo, tmp_path)
    (tmp_path / "good.txt").write_text("good")
    # Both kinds of dirt
    (tmp_path / "user_wip.txt").write_text("user WIP")
    (tmp_path / ".kibrary").mkdir()
    (tmp_path / ".kibrary" / "staging").mkdir()
    (tmp_path / ".kibrary" / "staging" / "in_flight.txt").write_text("staging")

    caplog.set_level(logging.DEBUG, logger="kibrary_sidecar.git_ops")
    result = auto_commit(tmp_path, "should not commit", ["good.txt"])
    assert result is None
    warning_msgs = [
        r.getMessage() for r in caplog.records
        if r.levelno >= logging.WARNING and "auto_commit" in r.getMessage()
    ]
    # The warning should mention the user file, NOT the kibrary scratch.
    assert any("user_wip.txt" in m for m in warning_msgs), warning_msgs
    assert not any(".kibrary/staging" in m for m in warning_msgs), warning_msgs
