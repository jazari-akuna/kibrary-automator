"""
Single source of truth for every Tauri event name the sidecar emits to the
frontend (forwarded via ``src-tauri/src/sidecar.rs`` which calls
``handle.emit(&n.event, n.params)``).

Mirrored on the frontend in ``src/utils/eventNames.ts`` and on the Rust
backend in ``src-tauri/src/event_names.rs``.

WHY THIS FILE EXISTS — Tauri 2's runtime event-name validator
(``plugin:event|emit`` and ``plugin:event|listen``) is::

    /^[A-Za-z0-9_\\-:/]+$/

Any name containing ``.`` is rejected with::

    "Event name must include only alphanumeric characters,
     `-`, `/`, `:` and `_`."

The 26.5.7-alpha.1..alpha.4 line shipped dotted names
(``download.progress``, ``download.done`` from the sidecar; plus
``app.close-requested``, ``staging.changed``, ``bootstrap.progress`` from
Rust). On the emit side ``handle.emit`` returned an error that nothing
checked; on the listen side ``listen()`` rejected silently. Frontend
features that depended on these events (Queue progress, file-watcher
auto-refetch, bootstrap progress UI) were therefore dead in production.

INVARIANT — every constant here MUST match its frontend + Rust twin
EXACTLY. The vitest ``eventNameValidity.test.ts`` spec walks all three
files and fails CI if the sets ever diverge.
"""

#: Per-part download progress (status: queued/downloading/ready/failed).
DOWNLOAD_PROGRESS = "download-progress"

#: Terminal event for the whole batch — fires once after run_batch().
DOWNLOAD_DONE = "download-done"

__all__ = ["DOWNLOAD_PROGRESS", "DOWNLOAD_DONE"]
