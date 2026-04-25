"""Safe git commit-undo helper.

Public API
----------
undo_last_commit(workspace, expected_sha) -> dict
    Resets HEAD to HEAD~1 if and only if HEAD matches *expected_sha* and the
    working tree is clean.  Returns ``{"ok": True}`` on success or
    ``{"ok": False, "reason": "<human-readable string>"}`` on refusal.
"""

import logging
from pathlib import Path

import git

log = logging.getLogger(__name__)


def undo_last_commit(workspace: Path | str, expected_sha: str) -> dict:
    """Reset HEAD to HEAD~1 when it is safe to do so.

    Safety checks (in order):
    1. *workspace* must be a git repository.
    2. HEAD must exactly match *expected_sha* (guards against racing commits).
    3. The working tree must be clean (no staged or unstaged changes, no
       untracked files) — we refuse to blow away uncommitted work.

    Parameters
    ----------
    workspace:
        Path to the root of the git repository.
    expected_sha:
        The full (40-char) or abbreviated SHA that the caller believes is
        currently HEAD.  The reset is refused if HEAD has moved past that SHA.

    Returns
    -------
    dict
        ``{"ok": True}`` on success, or
        ``{"ok": False, "reason": "<str>"}`` when refused.
    """
    workspace = Path(workspace)

    try:
        repo = git.Repo(workspace)
    except (git.InvalidGitRepositoryError, git.NoSuchPathError):
        return {"ok": False, "reason": "not a git repository"}

    # Guard: make sure there is at least one commit and HEAD is not detached.
    if repo.head.is_detached:
        return {"ok": False, "reason": "detached HEAD — refusing to undo"}

    # Check that HEAD matches the expected SHA.
    head_sha = repo.head.commit.hexsha
    if not head_sha.startswith(expected_sha) and not expected_sha.startswith(head_sha):
        return {
            "ok": False,
            "reason": (
                f"HEAD is {head_sha[:12]}, expected {expected_sha[:12]} — "
                "a newer commit exists; undo refused"
            ),
        }

    # Guard: dirty working tree.
    if repo.is_dirty(untracked_files=True):
        return {
            "ok": False,
            "reason": "working tree is dirty — commit or stash changes before undoing",
        }

    # Guard: make sure there is a parent commit to reset to.
    if not repo.head.commit.parents:
        return {"ok": False, "reason": "cannot undo the initial commit"}

    # All checks passed — perform the hard reset.
    repo.git.reset("--hard", "HEAD~1")
    new_head = repo.head.commit.hexsha
    log.info("undo_last_commit: reset to %s (was %s)", new_head[:12], head_sha[:12])
    return {"ok": True}
