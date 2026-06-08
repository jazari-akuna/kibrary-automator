"""Per-domain RPC handler modules.

``methods.py`` is a thin aggregator that imports each domain module's
``REGISTRY`` and merges them into the single top-level ``REGISTRY`` consumed by
``rpc.py``. The handlers live here, grouped by domain, so the dispatch surface
stays navigable.

The lazy-import accessor helpers (``_lib_scanner`` / ``_search_client`` / ...)
live in :mod:`kibrary_sidecar.handlers._common`; the handlers import them from
there so that merely importing this package (or ``methods``) still does NOT
eagerly pull in ``kiutils`` / ``httpx``. See ``tests/test_lazy_imports.py``.
"""
