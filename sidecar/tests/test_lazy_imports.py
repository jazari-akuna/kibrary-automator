"""Regression test: importing ``kibrary_sidecar.methods`` must NOT eagerly
pull in heavy modules (``kiutils`` via lib_scanner/lib_ops/model3d_ops, and
``httpx`` via search_client).

These imports delay the sidecar's first-RPC readiness, which blocks app
startup. The RPCs the frontend hits first (``system.ping`` / ``system.version``)
have no need for kiutils or httpx, so neither should be loaded merely by
importing the dispatch module.

Each check runs in a *fresh subprocess* so a stale ``sys.modules`` populated by
other tests (which legitimately import kiutils/httpx) cannot mask a regression.
"""

import subprocess
import sys
import textwrap


def _run(snippet: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(snippet)],
        capture_output=True,
        text=True,
    )


def test_importing_methods_does_not_load_kiutils_or_httpx():
    """Bare ``import kibrary_sidecar.methods`` stays light."""
    proc = _run(
        """
        import sys
        import kibrary_sidecar.methods  # noqa: F401
        assert 'kiutils' not in sys.modules, 'kiutils eagerly imported by methods'
        assert 'httpx' not in sys.modules, 'httpx eagerly imported by methods'
        print('OK')
        """
    )
    assert proc.returncode == 0, (
        f"subprocess failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    assert "OK" in proc.stdout


def test_importing_rpc_startup_chain_does_not_load_httpx():
    """The real startup chain is ``__main__`` -> ``rpc`` -> {methods,
    downloader}. ``downloader`` used to ``import search_client`` at module top,
    which eagerly pulled in ``httpx`` (TLS/SSL machinery) onto the sidecar's
    first-RPC critical path. ``rpc`` itself must also not import httpx.

    Replicates the startup entry chain in a fresh subprocess so a stale
    ``sys.modules`` populated by other tests cannot mask the regression.
    """
    proc = _run(
        """
        import sys
        import kibrary_sidecar.rpc  # noqa: F401 — the startup entry chain
        assert 'httpx' not in sys.modules, (
            'httpx eagerly imported by the rpc startup chain'
        )
        print('OK')
        """
    )
    assert proc.returncode == 0, (
        f"subprocess failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    assert "OK" in proc.stdout


def test_downloader_loads_httpx_only_when_http_performing_code_runs():
    """``httpx`` must load lazily once code that actually performs HTTP runs.

    Proves the import was deferred (lazy), not removed/broken: importing the
    downloader module stays httpx-free, but reaching into its search_client
    accessor pulls httpx in.
    """
    proc = _run(
        """
        import sys
        import kibrary_sidecar.downloader as dl

        # Importing the module alone stays light.
        assert 'httpx' not in sys.modules, 'downloader eagerly imported httpx'

        # The lazy accessor that the HTTP-performing path uses loads httpx.
        sc = dl._search_client()
        assert sc is not None
        assert 'httpx' in sys.modules, 'search_client accessor did not load httpx'
        print('OK')
        """
    )
    assert proc.returncode == 0, (
        f"subprocess failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    assert "OK" in proc.stdout


def test_accessors_lazily_load_heavy_modules():
    """Invoking the lazy accessors *does* load the heavy modules — proving the
    handlers still resolve their dependencies (lazy, not broken)."""
    proc = _run(
        """
        import sys
        import kibrary_sidecar.methods as m

        # Sanity: still clean right after import.
        assert 'kiutils' not in sys.modules
        assert 'httpx' not in sys.modules

        # lib_scanner-backed accessor -> pulls kiutils.
        scanner = m._lib_scanner()
        assert scanner is not None
        assert 'kiutils' in sys.modules, 'lib_scanner accessor did not load kiutils'

        # search_client-backed accessor -> pulls httpx.
        sc = m._search_client()
        assert sc is not None
        assert 'httpx' in sys.modules, 'search_client accessor did not load httpx'

        # model3d_ops and lib_ops accessors resolve too.
        assert m._model3d_ops() is not None
        assert m._lib_ops() is not None
        print('OK')
        """
    )
    assert proc.returncode == 0, (
        f"subprocess failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    assert "OK" in proc.stdout
