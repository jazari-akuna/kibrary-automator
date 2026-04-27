"""Sidecar entry point. Launched by the Rust shell as a subprocess."""

import os
import sys

# Silence GitPython's noisy ImportError when `git` isn't on PATH.
# Users without git see a runtime error from git_ops only when they
# actually try to commit — non-git workflows still work.
os.environ.setdefault("GIT_PYTHON_REFRESH", "quiet")

from kibrary_sidecar import __version__  # noqa: E402
from kibrary_sidecar.rpc import serve  # noqa: E402  (env var must be set first)


def _bootstrap_diagnostics() -> None:
    """Single-line stderr diagnostic so production logs unambiguously show
    whether the Rust shell injected KIBRARY_SEARCH_API_KEY (the recurring
    "thumbnails don't load" bug) and which sidecar version is running.

    The Rust side mirrors this print into the kibrary-app stderr stream by
    forwarding `child.stderr` (see src-tauri/src/sidecar.rs::wire), so the
    end user only needs `kibrary 2>&1 | grep \\[sidecar\\]` to triage.
    """
    key = os.environ.get("KIBRARY_SEARCH_API_KEY", "")
    print(
        f"[sidecar] startup version={__version__} "
        f"KIBRARY_SEARCH_API_KEY={'set' if key else 'MISSING'} "
        f"key_len={len(key)}",
        file=sys.stderr,
        flush=True,
    )


def main() -> None:
    _bootstrap_diagnostics()
    serve()


if __name__ == "__main__":
    main()
