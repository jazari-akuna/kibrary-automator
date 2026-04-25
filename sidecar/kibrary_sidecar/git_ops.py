"""Git auto-commit helpers for kibrary-automator.

Public API
----------
is_clean_repo(workspace)       -> bool
is_safe_to_commit(workspace)   -> tuple[bool, str | None]
auto_commit(workspace, message, paths, enabled) -> str | None
init_repo(workspace)           -> None
"""

import logging
from pathlib import Path

import git

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def init_repo(workspace: Path) -> None:
    """Initialise a git repository at *workspace* (idempotent)."""
    try:
        git.Repo(workspace)  # already a repo — nothing to do
    except git.InvalidGitRepositoryError:
        git.Repo.init(workspace)
        log.info("Initialised git repo at %s", workspace)


def is_clean_repo(workspace: Path) -> bool:
    """Return True if the working tree has no uncommitted changes.

    Both staged and unstaged changes, as well as untracked files, make the
    repo "dirty".  Returns False if *workspace* is not a git repository.
    """
    try:
        repo = git.Repo(workspace)
    except (git.InvalidGitRepositoryError, git.NoSuchPathError):
        return False
    return not repo.is_dirty(untracked_files=True)


def is_safe_to_commit(workspace: Path) -> tuple[bool, str | None]:
    """Check whether it is safe to create an automated commit.

    Returns a ``(safe, reason)`` tuple.  When *safe* is ``True``, *reason*
    is ``None``.  When *safe* is ``False``, *reason* is a human-readable
    string describing the problem.

    Conditions that block auto-commit:
    - Not a git repository
    - Detached HEAD
    - Mid-rebase  (``rebase-merge/`` or ``rebase-apply/`` present)
    - Mid-bisect  (``BISECT_HEAD`` present)
    - Mid-merge   (``MERGE_HEAD`` present)
    """
    try:
        repo = git.Repo(workspace)
    except git.InvalidGitRepositoryError:
        return False, "not a git repository"
    except git.NoSuchPathError:
        return False, "not a git repository"

    git_dir = Path(repo.git_dir)

    # Detached HEAD
    if repo.head.is_detached:
        return False, "detached HEAD"

    # Mid-merge
    if (git_dir / "MERGE_HEAD").exists():
        return False, "mid-merge in progress"

    # Mid-rebase (two possible directory names)
    if (git_dir / "rebase-merge").is_dir() or (git_dir / "rebase-apply").is_dir():
        return False, "rebase in progress"

    # Mid-bisect
    if (git_dir / "BISECT_HEAD").exists():
        return False, "bisect in progress"

    return True, None


def auto_commit(
    workspace: Path,
    message: str,
    paths: list[str],
    enabled: bool = True,
) -> str | None:
    """Stage *paths* and create a commit in *workspace*.

    Returns the full 40-character commit SHA on success, or ``None`` if the
    commit was skipped.

    Skip conditions:
    - *enabled* is ``False``
    - The repository is not in a safe state (see :func:`is_safe_to_commit`)
    - The working tree has changes *outside* the listed *paths* — we refuse
      to auto-commit while someone else has WIP in the same repo.
    """
    if not enabled:
        log.debug("auto_commit: disabled, skipping")
        return None

    safe, reason = is_safe_to_commit(workspace)
    if not safe:
        log.warning("auto_commit: unsafe to commit (%s), skipping", reason)
        return None

    try:
        repo = git.Repo(workspace)
    except (git.InvalidGitRepositoryError, git.NoSuchPathError):
        log.warning("auto_commit: workspace is not a git repo")
        return None

    # Check for dirty working tree *outside* the paths we intend to commit.
    # We look at both staged (index) and unstaged changes plus untracked files.
    dirty = _dirty_files(repo)
    # Normalise the caller-supplied paths to forward-slash relative strings
    # so we can compare them against what GitPython reports.
    norm_paths = {p.replace("\\", "/") for p in paths}
    extra_dirty = dirty - norm_paths
    if extra_dirty:
        log.warning(
            "auto_commit: working tree is dirty outside target paths (%s), skipping",
            sorted(extra_dirty),
        )
        return None

    # Stage the listed paths and commit.
    # Only stage files that actually exist (new or modified); deletions are
    # handled via index.remove which we skip for simplicity — callers deal
    # with deletions separately if needed.
    existing = [p for p in paths if (workspace / p).exists()]
    if existing:
        repo.index.add(existing)

    commit = repo.index.commit(message)
    sha = commit.hexsha
    log.info("auto_commit: created commit %s — %s", sha[:8], message)
    return sha


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _dirty_files(repo: git.Repo) -> set[str]:
    """Return the set of relative file paths that are dirty in *repo*.

    Includes staged changes, unstaged modifications, and untracked files.
    Paths are normalised to forward-slash strings relative to the repo root.
    """
    dirty: set[str] = set()

    # Staged changes (diff between HEAD and index).
    # On a repo with no commits yet head.commit raises — handle gracefully.
    try:
        for diff in repo.index.diff(repo.head.commit):
            if diff.a_path:
                dirty.add(diff.a_path)
            if diff.b_path:
                dirty.add(diff.b_path)
    except (git.BadName, ValueError):
        # No commits yet — anything staged counts.
        for entry in repo.index.entries:
            dirty.add(entry[0])  # entry is (path, stage)

    # Unstaged modifications (diff between index and working tree).
    for diff in repo.index.diff(None):
        if diff.a_path:
            dirty.add(diff.a_path)
        if diff.b_path:
            dirty.add(diff.b_path)

    # Untracked files.
    for f in repo.untracked_files:
        dirty.add(f)

    return dirty
