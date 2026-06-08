"""Thin aggregator for the sync RPC dispatch table.

The ~70 handler functions used to live here in one ~960-line module. They now
live in :mod:`kibrary_sidecar.handlers`, grouped by domain; this module imports
each domain's ``REGISTRY`` map and merges them into the single top-level
``REGISTRY`` consumed by ``rpc.py``.

Public surface preserved:

* ``from kibrary_sidecar.methods import REGISTRY`` — unchanged keys → handlers.
* The lazy-import accessor helpers (``_lib_scanner`` / ``_search_client`` /
  ``_model3d_ops`` / ``_lib_ops`` / ...) are re-exported here because
  ``tests/test_lazy_imports.py`` reaches into ``methods._lib_scanner()`` etc.
* Individual handler functions that tests import by name
  (``library_suggest``, ``library_check_duplicate``, ``kicad_detect``,
  ``kicad_get_active``, ``kicad_set_active``, ``library_get_3d_info``,
  ``library_set_3d_offset``, ``library_render_3d_glb_angled``) are re-exported
  for backwards compatibility.

Importing this module must STILL NOT eagerly pull in ``kiutils`` / ``httpx`` —
the handler modules defer those imports to the accessors in
:mod:`kibrary_sidecar.handlers._common`, which only run inside handler bodies.
"""

# Re-export the lazy-import accessors so callers (and tests) that reference
# ``methods._lib_scanner`` / ``methods._search_client`` / ... keep working.
from kibrary_sidecar.handlers._common import (  # noqa: F401
    _search_client,
    _lib_scanner,
    _lib_ops,
    _model3d_ops,
    _symfile,
    _library,
    _sexpr_diff,
    _drop_import,
    _packaging,
)

from kibrary_sidecar.handlers import system as _system
from kibrary_sidecar.handlers import workspace as _workspace
from kibrary_sidecar.handlers import settings as _settings
from kibrary_sidecar.handlers import kicad as _kicad
from kibrary_sidecar.handlers import parts as _parts
from kibrary_sidecar.handlers import library as _library_h
from kibrary_sidecar.handlers import render as _render
from kibrary_sidecar.handlers import search as _search
from kibrary_sidecar.handlers import drop_import as _drop

# Re-export specific handlers that other modules / tests import by name.
from kibrary_sidecar.handlers.kicad import (  # noqa: F401
    kicad_detect,
    kicad_get_active,
    kicad_set_active,
)
from kibrary_sidecar.handlers.library import (  # noqa: F401
    library_suggest,
    library_check_duplicate,
    library_get_3d_info,
    library_set_3d_offset,
)
from kibrary_sidecar.handlers.render import (  # noqa: F401
    library_render_3d_glb_angled,
)


REGISTRY: dict = {
    **_system.REGISTRY,
    **_workspace.REGISTRY,
    **_settings.REGISTRY,
    **_kicad.REGISTRY,
    **_parts.REGISTRY,
    **_library_h.REGISTRY,
    **_render.REGISTRY,
    **_search.REGISTRY,
    **_drop.REGISTRY,
}
