"""Lazy-import accessors for heavy modules, shared across handler domains.

Importing these at module top-level delayed the sidecar's first-RPC
readiness (which blocks app startup): ``search_client`` builds a
module-scoped ``httpx.Client`` at import time, and
``lib_scanner`` / ``lib_ops`` / ``model3d_ops`` / ``symfile`` / ``library`` /
``sexpr_diff`` / ``drop_import`` each pull in ``kiutils`` (directly or
transitively). The first RPCs the frontend hits
(``system.ping`` / ``system.version``) need none of these, so we defer the
import to the first handler that actually uses each module.

Python caches modules in ``sys.modules``, so every call after the first is
just a dict lookup — there is no per-call cost worth memoising beyond that.
The REGISTRY references handler *functions*, which stay valid; only
*when* the module import happens changes.
"""


def _search_client():
    from kibrary_sidecar import search_client
    return search_client


def _lib_scanner():
    from kibrary_sidecar import lib_scanner
    return lib_scanner


def _lib_ops():
    from kibrary_sidecar import lib_ops
    return lib_ops


def _model3d_ops():
    from kibrary_sidecar import model3d_ops
    return model3d_ops


def _symfile():
    from kibrary_sidecar import symfile
    return symfile


def _library():
    from kibrary_sidecar import library
    return library


def _sexpr_diff():
    from kibrary_sidecar import sexpr_diff
    return sexpr_diff


def _drop_import():
    from kibrary_sidecar import drop_import
    return drop_import


def _packaging():
    from kibrary_sidecar import packaging
    return packaging
