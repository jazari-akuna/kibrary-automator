"""Sidecar entry point. The actual RPC server (rpc.py) is wired in Task 4."""

import sys


def main() -> None:
    try:
        from kibrary_sidecar.rpc import serve
    except ImportError:
        print(
            "kibrary_sidecar: RPC server not yet implemented (see Task 4 of the P1 plan)",
            file=sys.stderr,
        )
        sys.exit(1)
    serve()


if __name__ == "__main__":
    main()
