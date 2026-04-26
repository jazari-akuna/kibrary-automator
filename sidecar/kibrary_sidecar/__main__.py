"""Sidecar entry point. Launched by the Rust shell as a subprocess."""

import os

# Silence GitPython's noisy ImportError when `git` isn't on PATH.
# Users without git see a runtime error from git_ops only when they
# actually try to commit — non-git workflows still work.
os.environ.setdefault("GIT_PYTHON_REFRESH", "quiet")

from kibrary_sidecar.rpc import serve  # noqa: E402  (env var must be set first)


def main() -> None:
    serve()


if __name__ == "__main__":
    main()
